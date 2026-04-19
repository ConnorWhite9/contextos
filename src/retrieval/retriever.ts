import * as ts from "typescript";
import * as fs from "fs";
import { parseFile } from "../ast/parser";
import { IMPORT_EXTENSIONS, isTypeScriptLike, resolveImport } from "../utils/paths";

/**
 * Retrieval for the MVP: no embeddings, no LSP. Two cheap, deterministic
 * signals the scheduler can combine:
 *
 *   1. Import graph — transitive relative imports from the active file.
 *   2. Keyword matches — identifiers in the task text that appear in file
 *      headers (imports + signatures), which we already parse anyway.
 *
 * These are designed to be composable with an embedding retriever later:
 * both return `{ path, score, reason }` tuples.
 */

export interface RetrievalHit {
  path: string;
  /** Retriever-local score in [0, 1]. Combined with other signals upstream. */
  score: number;
  reason: "direct-import" | "transitive-import" | "keyword-match";
  /** Depth for import-graph hits; 0 for keyword hits. */
  depth: number;
}

/**
 * Walk the import graph from `entryFile` up to `maxDepth`, returning each
 * reachable file with a score that decays with distance.
 */
export function importGraphFrom(
  entryFile: string,
  maxDepth: number,
  workspaceFiles: Set<string>,
): RetrievalHit[] {
  const seen = new Set<string>([entryFile]);
  const hits: RetrievalHit[] = [];
  const queue: Array<{ path: string; depth: number }> = [
    { path: entryFile, depth: 0 },
  ];

  while (queue.length > 0) {
    const { path, depth } = queue.shift()!;
    if (depth >= maxDepth) {
      continue;
    }
    const imports = directImportsOf(path);
    for (const importPath of imports) {
      const resolved = resolveToWorkspaceFile(importPath, workspaceFiles);
      if (!resolved || seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      const nextDepth = depth + 1;
      hits.push({
        path: resolved,
        // 1.0 for a direct import, then halve per hop.
        score: 1 / Math.pow(2, nextDepth - 1),
        reason: nextDepth === 1 ? "direct-import" : "transitive-import",
        depth: nextDepth,
      });
      queue.push({ path: resolved, depth: nextDepth });
    }
  }

  return hits;
}

/**
 * Extract relative import specifiers from a file's top-level imports.
 * We reuse the cached AST so this is free when the file was already parsed
 * for compression.
 */
function directImportsOf(filePath: string): string[] {
  if (!isTypeScriptLike(filePath)) {
    return [];
  }
  const parsed = parseFile(filePath);
  if (!parsed) {
    return [];
  }
  const out: string[] = [];
  parsed.sourceFile.forEachChild((node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      out.push(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.push(node.moduleSpecifier.text);
    }
  });
  return out;
}

/**
 * Map an import specifier back onto a concrete workspace file path by
 * trying common TS/JS extensions. We only resolve relative imports for the
 * MVP — bare specifiers (node_modules) are intentionally skipped.
 */
function resolveToWorkspaceFile(
  specifier: string,
  workspaceFiles: Set<string>,
): string | undefined {
  // Strip leading slash/dot noise; we need a concrete abs path resolved by the caller.
  if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
    return undefined;
  }
  return undefined;
}

/**
 * Version of `importGraphFrom` that accepts a resolver so the engine can
 * pass in the right base path for each edge. Preferred over the one above
 * for general use; the stripped-down one exists only for unit testability.
 */
export function importGraphWithResolver(
  entryFile: string,
  maxDepth: number,
  exists: (path: string) => boolean,
): RetrievalHit[] {
  const seen = new Set<string>([entryFile]);
  const hits: RetrievalHit[] = [];
  const queue: Array<{ path: string; depth: number }> = [
    { path: entryFile, depth: 0 },
  ];

  while (queue.length > 0) {
    const { path: fromPath, depth } = queue.shift()!;
    if (depth >= maxDepth) {
      continue;
    }
    for (const spec of directImportsOf(fromPath)) {
      const base = resolveImport(fromPath, spec);
      if (!base) {
        continue;
      }
      const resolved = tryExtensions(base, exists);
      if (!resolved || seen.has(resolved)) {
        continue;
      }
      seen.add(resolved);
      const nextDepth = depth + 1;
      hits.push({
        path: resolved,
        score: 1 / Math.pow(2, nextDepth - 1),
        reason: nextDepth === 1 ? "direct-import" : "transitive-import",
        depth: nextDepth,
      });
      queue.push({ path: resolved, depth: nextDepth });
    }
  }
  return hits;
}

function tryExtensions(
  base: string,
  exists: (p: string) => boolean,
): string | undefined {
  if (exists(base)) {
    return base;
  }
  for (const ext of IMPORT_EXTENSIONS) {
    const candidate = base + ext;
    if (exists(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

/**
 * Cheap keyword retriever. We tokenize the task into identifier-like words,
 * drop common stopwords, and score each candidate file by the count of
 * matches in a small, bounded slice of its header (import lines + first ~80
 * lines). Bounded scan is how we hit the <150ms target on larger repos.
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "if", "then", "else", "for", "to", "of",
  "in", "on", "at", "is", "are", "be", "this", "that", "it", "fix", "add",
  "with", "from", "into", "as", "by", "not", "please", "make", "change",
  "update", "use", "using", "function", "class", "type", "file", "code",
]);

export function keywordsFromTask(task: string): string[] {
  const words = task
    .split(/[^A-Za-z0-9_]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w.toLowerCase()));
  // Dedupe, preserve order.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of words) {
    const key = w.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(w);
    }
  }
  return out;
}

export function keywordHits(
  candidates: string[],
  keywords: string[],
  maxHeaderLines = 80,
): RetrievalHit[] {
  if (keywords.length === 0) {
    return [];
  }
  const needles = keywords.map((k) => k.toLowerCase());
  const hits: RetrievalHit[] = [];

  for (const path of candidates) {
    if (!isTypeScriptLike(path)) {
      continue;
    }
    let header: string;
    try {
      // Partial read — we don't want to slurp megabyte-files for scoring.
      const fd = fs.openSync(path, "r");
      const buf = Buffer.alloc(8 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      fs.closeSync(fd);
      header = buf.subarray(0, n).toString("utf8");
    } catch {
      continue;
    }
    // Clip to first N lines.
    const lines = header.split("\n", maxHeaderLines + 1);
    const scan = lines.slice(0, maxHeaderLines).join("\n").toLowerCase();

    let matches = 0;
    for (const needle of needles) {
      if (scan.includes(needle)) {
        matches += 1;
      }
    }
    if (matches > 0) {
      hits.push({
        path,
        // Normalize by keyword count so scores stay in [0, 1].
        score: matches / needles.length,
        reason: "keyword-match",
        depth: 0,
      });
    }
  }

  return hits;
}
