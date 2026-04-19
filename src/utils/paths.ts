import * as path from "path";

/**
 * Path helpers — kept separate from `vscode` imports so tests and the
 * engine can manipulate paths without a VS Code host.
 */

export function isTypeScriptLike(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return ext === ".ts" || ext === ".tsx" || ext === ".js" || ext === ".jsx";
}

export function isTestFile(filePath: string): boolean {
  const base = path.basename(filePath).toLowerCase();
  return (
    base.includes(".test.") ||
    base.includes(".spec.") ||
    filePath.includes("/__tests__/")
  );
}

/**
 * Importance weight by file kind. Used by the prioritizer as one of several
 * multipliers — tests score lower because they're rarely the thing you
 * need the model to read to make a change in product code.
 */
export function fileKindWeight(filePath: string): number {
  const base = path.basename(filePath).toLowerCase();
  if (base === "package.json") {
    return 0.9;
  }
  if (base === "tsconfig.json") {
    return 0.6;
  }
  if (isTestFile(filePath)) {
    return 0.3;
  }
  if (base.endsWith(".d.ts")) {
    return 0.7;
  }
  if (isTypeScriptLike(filePath)) {
    return 1.0;
  }
  return 0.4;
}

/** Normalize a possibly-relative import specifier against a source file. */
export function resolveImport(
  fromFile: string,
  specifier: string,
): string | undefined {
  if (!specifier.startsWith(".")) {
    return undefined; // bare module — ignore for the MVP
  }
  const dir = path.dirname(fromFile);
  const resolved = path.resolve(dir, specifier);
  return resolved;
}

/** Candidate extensions to try when resolving an import with no extension. */
export const IMPORT_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];
