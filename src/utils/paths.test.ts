import { describe, expect, test } from "vitest";
import { fileKindWeight, isTestFile, isTypeScriptLike, resolveImport } from "./paths";
import * as path from "path";

describe("utils/paths", () => {
  // --- isTypeScriptLike -----------------------------------------------------

  test("returns true for .ts files", () => {
    expect(isTypeScriptLike("src/foo.ts")).toBe(true);
    expect(isTypeScriptLike("/abs/path/bar.ts")).toBe(true);
  });

  test("returns true for .tsx files", () => {
    expect(isTypeScriptLike("Component.tsx")).toBe(true);
  });

  test("returns true for .js files", () => {
    expect(isTypeScriptLike("index.js")).toBe(true);
  });

  test("returns true for .jsx files", () => {
    expect(isTypeScriptLike("App.jsx")).toBe(true);
  });

  test("returns false for .json files", () => {
    expect(isTypeScriptLike("package.json")).toBe(false);
  });

  test("returns false for .md files", () => {
    expect(isTypeScriptLike("README.md")).toBe(false);
  });

  test("returns false for .py files", () => {
    expect(isTypeScriptLike("script.py")).toBe(false);
  });

  test("is case-insensitive on the extension", () => {
    expect(isTypeScriptLike("FOO.TS")).toBe(true);
    expect(isTypeScriptLike("bar.TSX")).toBe(true);
  });

  // --- isTestFile -----------------------------------------------------------

  test("returns true for .test.ts files", () => {
    expect(isTestFile("foo.test.ts")).toBe(true);
  });

  test("returns true for .spec.ts files", () => {
    expect(isTestFile("bar.spec.ts")).toBe(true);
  });

  test("returns true for files under __tests__ directories", () => {
    expect(isTestFile("/src/__tests__/utils.ts")).toBe(true);
  });

  test("returns false for regular source files", () => {
    expect(isTestFile("src/engine.ts")).toBe(false);
    expect(isTestFile("src/index.ts")).toBe(false);
  });

  // --- fileKindWeight -------------------------------------------------------

  test("regular .ts source file has weight 1.0", () => {
    expect(fileKindWeight("src/engine.ts")).toBe(1.0);
  });

  test("test files have lower weight than source files", () => {
    expect(fileKindWeight("src/engine.test.ts")).toBeLessThan(fileKindWeight("src/engine.ts"));
  });

  test("test file weight is 0.3", () => {
    expect(fileKindWeight("src/foo.test.ts")).toBe(0.3);
  });

  test("declaration files (.d.ts) have weight 0.7", () => {
    expect(fileKindWeight("src/types.d.ts")).toBe(0.7);
  });

  test("package.json has weight 0.9", () => {
    expect(fileKindWeight("package.json")).toBe(0.9);
  });

  test("tsconfig.json has weight 0.6", () => {
    expect(fileKindWeight("tsconfig.json")).toBe(0.6);
  });

  test("unknown file type has weight 0.4", () => {
    expect(fileKindWeight("notes.txt")).toBe(0.4);
  });

  // --- resolveImport --------------------------------------------------------

  test("resolves a relative specifier against the source file's directory", () => {
    const result = resolveImport("/src/api/user.ts", "./helpers");
    expect(result).toBe(path.resolve("/src/api", "./helpers"));
  });

  test("resolves parent-directory relative specifier", () => {
    const result = resolveImport("/src/api/user.ts", "../utils");
    expect(result).toBe(path.resolve("/src/api", "../utils"));
  });

  test("returns undefined for bare module specifiers", () => {
    expect(resolveImport("/src/index.ts", "react")).toBeUndefined();
    expect(resolveImport("/src/index.ts", "@scope/pkg")).toBeUndefined();
  });

  test("returns undefined for node: protocol specifiers", () => {
    expect(resolveImport("/src/index.ts", "node:fs")).toBeUndefined();
  });

  test("resolves specifier with explicit .ts extension", () => {
    const result = resolveImport("/src/index.ts", "./engine.ts");
    expect(result).toBe(path.resolve("/src", "./engine.ts"));
  });
});
