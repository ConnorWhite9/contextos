import * as fs from "fs";
import * as path from "path";
import { isTypeScriptLike } from "../utils/paths";

/**
 * CLI replacement for the VS Code `collectWorkspacePaths` helper.
 *
 * Recursively walks `root`, skipping well-known non-source directories, and
 * returns up to `maxFiles` TypeScript/JavaScript paths. Mirrors the VS Code
 * version's exclusion list so the engine sees the same candidates either way.
 */

const EXCLUDE_DIRS = new Set([
  "node_modules",
  "out",
  "dist",
  "build",
  ".git",
  ".vscode-test",
  "coverage",
  ".next",
  ".nuxt",
  ".turbo",
]);

export function collectWorkspacePathsFromFs(root: string, maxFiles: number): string[] {
  const results: string[] = [];
  walk(root, results, maxFiles);
  return results;
}

function walk(dir: string, out: string[], max: number): void {
  if (out.length >= max) {
    return;
  }
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (out.length >= max) {
      return;
    }
    if (entry.isDirectory()) {
      if (!EXCLUDE_DIRS.has(entry.name) && !entry.name.startsWith(".")) {
        walk(path.join(dir, entry.name), out, max);
      }
    } else if (entry.isFile() && isTypeScriptLike(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
}
