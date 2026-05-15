import { describe, expect, test } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { collectWorkspacePathsFromFs } from "./fileWorkspace";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contextos-workspace-"));
}

/** Create a file at a path, making parent directories as needed. */
function touch(filePath: string, content = ""): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content, "utf8");
}

describe("cli/fileWorkspace", () => {
  // --- basic discovery ------------------------------------------------------

  test("discovers .ts files in the workspace root", () => {
    const root = tmpDir();
    touch(path.join(root, "index.ts"));
    touch(path.join(root, "utils.ts"));

    const paths = collectWorkspacePathsFromFs(root, 100);
    expect(paths.some((p) => p.endsWith("index.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("utils.ts"))).toBe(true);
  });

  test("discovers .tsx, .js, and .jsx files", () => {
    const root = tmpDir();
    touch(path.join(root, "App.tsx"));
    touch(path.join(root, "helper.js"));
    touch(path.join(root, "widget.jsx"));

    const paths = collectWorkspacePathsFromFs(root, 100);
    expect(paths.some((p) => p.endsWith("App.tsx"))).toBe(true);
    expect(paths.some((p) => p.endsWith("helper.js"))).toBe(true);
    expect(paths.some((p) => p.endsWith("widget.jsx"))).toBe(true);
  });

  test("recurses into subdirectories", () => {
    const root = tmpDir();
    touch(path.join(root, "src", "api", "user.ts"));
    touch(path.join(root, "src", "utils", "paths.ts"));

    const paths = collectWorkspacePathsFromFs(root, 100);
    expect(paths.some((p) => p.endsWith("user.ts"))).toBe(true);
    expect(paths.some((p) => p.endsWith("paths.ts"))).toBe(true);
  });

  // --- excluded directories -------------------------------------------------

  test("excludes node_modules", () => {
    const root = tmpDir();
    touch(path.join(root, "src", "index.ts"));
    touch(path.join(root, "node_modules", "dep", "index.ts"));

    const paths = collectWorkspacePathsFromFs(root, 100);
    expect(paths.every((p) => !p.includes("node_modules"))).toBe(true);
  });

  test("excludes out directory", () => {
    const root = tmpDir();
    touch(path.join(root, "src", "index.ts"));
    touch(path.join(root, "out", "index.js"));

    const paths = collectWorkspacePathsFromFs(root, 100);
    const outPaths = paths.filter((p) => p.includes(`${path.sep}out${path.sep}`));
    expect(outPaths).toHaveLength(0);
  });

  test("excludes dist and build directories", () => {
    const root = tmpDir();
    touch(path.join(root, "src", "index.ts"));
    touch(path.join(root, "dist", "bundle.js"));
    touch(path.join(root, "build", "output.ts"));

    const paths = collectWorkspacePathsFromFs(root, 100);
    expect(paths.every((p) => !p.includes(`${path.sep}dist${path.sep}`))).toBe(true);
    expect(paths.every((p) => !p.includes(`${path.sep}build${path.sep}`))).toBe(true);
  });

  test("excludes hidden directories (starting with .)", () => {
    const root = tmpDir();
    touch(path.join(root, "src", "index.ts"));
    touch(path.join(root, ".cache", "temp.ts"));
    touch(path.join(root, ".git", "COMMIT_EDITMSG"));

    const paths = collectWorkspacePathsFromFs(root, 100);
    expect(paths.every((p) => !p.includes(`${path.sep}.`))).toBe(true);
  });

  test("excludes non-TS/JS file types", () => {
    const root = tmpDir();
    touch(path.join(root, "README.md"));
    touch(path.join(root, "schema.json"));
    touch(path.join(root, "styles.css"));
    touch(path.join(root, "index.ts")); // this one should be included

    const paths = collectWorkspacePathsFromFs(root, 100);
    expect(paths.every((p) => /\.(ts|tsx|js|jsx)$/.test(p))).toBe(true);
  });

  // --- maxFiles cap ---------------------------------------------------------

  test("respects the maxFiles cap", () => {
    const root = tmpDir();
    for (let i = 0; i < 20; i++) {
      touch(path.join(root, `file${i}.ts`));
    }

    const paths = collectWorkspacePathsFromFs(root, 5);
    expect(paths.length).toBeLessThanOrEqual(5);
  });

  test("returns all files when count is below the cap", () => {
    const root = tmpDir();
    touch(path.join(root, "a.ts"));
    touch(path.join(root, "b.ts"));

    const paths = collectWorkspacePathsFromFs(root, 1000);
    expect(paths.length).toBe(2);
  });

  // --- edge cases -----------------------------------------------------------

  test("returns empty array for an empty workspace", () => {
    const root = tmpDir();
    const paths = collectWorkspacePathsFromFs(root, 100);
    expect(paths).toEqual([]);
  });

  test("returns absolute paths", () => {
    const root = tmpDir();
    touch(path.join(root, "index.ts"));

    const paths = collectWorkspacePathsFromFs(root, 100);
    expect(paths.every((p) => path.isAbsolute(p))).toBe(true);
  });

  test("does not include duplicate paths", () => {
    const root = tmpDir();
    touch(path.join(root, "index.ts"));

    const paths = collectWorkspacePathsFromFs(root, 100);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });
});
