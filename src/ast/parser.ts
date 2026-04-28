import * as ts from "typescript";
import * as fs from "fs";
import * as path from "path";
import { log } from "../utils/logger";

/**
 * AST parser with an mtime-keyed cache.
 *
 * Rationale: parsing TypeScript via the compiler API is ~0.5–5 ms per file
 * with `createSourceFile` (syntactic only — no type checker). For a real
 * workspace that multiplies fast. We key the cache on `(path, mtimeMs)` so
 * edits invalidate automatically without a watcher; adding a watcher for
 * eager invalidation is a straightforward follow-up.
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

  get(filePath: string, mtimeMs: number): CacheEntry | undefined {
    const hit = this.map.get(filePath);
    if (hit && hit.mtimeMs === mtimeMs) {
      // refresh LRU position
      this.map.delete(filePath);
      this.map.set(filePath, hit);
      return hit;
    }
    return undefined;
  }

  set(filePath: string, entry: CacheEntry): void {
    if (this.map.has(filePath)) {
      this.map.delete(filePath);
    }
    this.map.set(filePath, entry);
    if (this.map.size > CACHE_CAPACITY) {
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
 * Map a file extension to the correct `ScriptKind`. Getting this right
 * matters: e.g. feeding a `.ts` file to the parser as `TSX` will break
 * legacy TypeScript cast syntax `<T>expr`.
 */
function scriptKindFor(filePath: string): ts.ScriptKind {
  const lower = filePath.toLowerCase();
  if (lower.endsWith(".d.ts")) {
    return ts.ScriptKind.TS;
  }
  const ext = path.extname(lower);
  switch (ext) {
    case ".tsx":
      return ts.ScriptKind.TSX;
    case ".ts":
      return ts.ScriptKind.TS;
    case ".jsx":
      return ts.ScriptKind.JSX;
    case ".js":
      return ts.ScriptKind.JS;
    case ".mjs":
    case ".cjs":
      return ts.ScriptKind.JS;
    default:
      return ts.ScriptKind.TS;
  }
}

/**
 * Parse a file, returning a cached SourceFile if the on-disk mtime matches.
 * Returns `undefined` on stat or read failure so callers can skip missing
 * files without exception handling at each call site.
 *
 * We intentionally swallow syntax errors — `createSourceFile` always
 * returns a best-effort tree, which is still useful for compression. If
 * there are parse diagnostics we log them once, at info level, so they
 * show up in the ContextOS output channel without spamming.
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
  } catch {
    log.warn(`parseFile: read failed for ${filePath}`);
    return undefined;
  }

  const sourceFile = ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ false,
    scriptKindFor(filePath),
  );

  // Surface parse diagnostics but don't abort compression — a partial
  // tree still yields useful signatures for the model.
  const diagnostics = (sourceFile as unknown as {
    parseDiagnostics?: ts.Diagnostic[];
  }).parseDiagnostics;
  if (diagnostics && diagnostics.length > 0) {
    log.info(
      `parseFile: ${filePath} has ${diagnostics.length} parse diagnostic${diagnostics.length === 1 ? "" : "s"}`,
    );
  }

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
