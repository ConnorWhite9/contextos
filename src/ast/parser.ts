import * as ts from "typescript";
import * as fs from "fs";
import { log } from "../utils/logger";

/**
 * AST parser with an mtime-keyed cache.
 *
 * Rationale: parsing TypeScript via the compiler API is ~10–30ms per file.
 * For a real workspace that multiplies fast. We key the cache on
 * `(path, mtimeMs)` so edits invalidate automatically without a watcher;
 * adding a watcher for eager invalidation is a straightforward follow-up.
 *
 * Limit the cache with a simple LRU to avoid unbounded growth — the MVP
 * cap is intentionally high enough to cover the default `maxFilesScanned`
 * (200) a few times over.
 */
interface CacheEntry {
  mtimeMs: number;
  sourceFile: ts.SourceFile;
  bytes: number;
}

const CACHE_CAPACITY = 512;

class AstCache {
  private map = new Map<string, CacheEntry>();

  get(path: string, mtimeMs: number): CacheEntry | undefined {
    const hit = this.map.get(path);
    if (hit && hit.mtimeMs === mtimeMs) {
      // refresh LRU position
      this.map.delete(path);
      this.map.set(path, hit);
      return hit;
    }
    return undefined;
  }

  set(path: string, entry: CacheEntry): void {
    if (this.map.has(path)) {
      this.map.delete(path);
    }
    this.map.set(path, entry);
    if (this.map.size > CACHE_CAPACITY) {
      // Drop the oldest entry (first inserted).
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) {
        this.map.delete(firstKey);
      }
    }
  }

  clear(): void {
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}

const cache = new AstCache();

export interface ParsedFile {
  path: string;
  mtimeMs: number;
  sourceFile: ts.SourceFile;
  bytes: number;
}

/**
 * Parse a file, returning a cached SourceFile if the on-disk mtime matches.
 * Returns `undefined` on stat failure so callers can skip missing files
 * without exception handling at each call site.
 */
export function parseFile(filePath: string): ParsedFile | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return undefined;
  }

  const mtimeMs = stat.mtimeMs;
  const hit = cache.get(filePath, mtimeMs);
  if (hit) {
    return {
      path: filePath,
      mtimeMs,
      sourceFile: hit.sourceFile,
      bytes: hit.bytes,
    };
  }

  let source: string;
  try {
    source = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    log.warn(`parseFile: read failed for ${filePath}`);
    return undefined;
  }

  // `setParentNodes: false` gives a meaningful speedup; we don't walk up
  // from a child node anywhere in the compressor. If that changes, flip it.
  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    ts.ScriptKind.TSX,
  );

  const bytes = Buffer.byteLength(source, "utf8");
  cache.set(filePath, { mtimeMs, sourceFile, bytes });
  return { path: filePath, mtimeMs, sourceFile, bytes };
}

export function clearAstCache(): void {
  cache.clear();
  log.info("AST cache cleared");
}

export function astCacheSize(): number {
  return cache.size();
}
