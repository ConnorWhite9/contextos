import { describe, expect, test } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compressFile, renderCompressed } from "./compressor";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contextos-compressor-"));
}

describe("ast/compressor", () => {
  // --- function + class signatures -------------------------------------------

  test("captures imports, exports, jsdoc, strips bodies and private members", () => {
    const dir = tmpDir();
    const dep = path.join(dir, "dep.ts");
    const file = path.join(dir, "mod.ts");

    fs.writeFileSync(dep, "export type Dep = { id: string };\n", "utf8");
    fs.writeFileSync(
      file,
      [
        "import { Dep } from './dep';",
        "",
        "/** Adds two numbers. */",
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export const fn = (x: { a: number } = { a: 1 }): Dep => {",
        "  return { id: String(x.a) } as any;",
        "};",
        "",
        "export default (y: number): number => y + 1;",
        "",
        "export class C {",
        "  public ok: string = 'long initializer should be dropped';",
        "  protected nope(): void { throw new Error('x'); }",
        "  #secret = 1;",
        "  /** method docs */",
        "  method<T extends { a: number }>(x = { a: 1 }): void {",
        "    console.log(x);",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    );

    const c = compressFile(file);
    expect(c).toBeTruthy();
    expect(c!.imports.join("\n")).toMatch(/import\s+\{\s*Dep\s*\}/);

    expect(c!.exports).toContain("add");
    expect(c!.exports).toContain("fn");
    expect(c!.exports).toContain("C");
    expect(c!.exports).toContain("default");

    const rendered = renderCompressed(c!);

    // JSDoc preserved above signature
    expect(rendered).toMatch(/\/\*\*[\s\S]*Adds two numbers\.[\s\S]*\*\//);
    // Function body stripped
    expect(rendered).toMatch(/export function add\(a: number, b: number\): number;/);
    expect(rendered).not.toMatch(/return a \+ b/);

    // Class shell present; initializer string dropped; protected/private hidden
    expect(rendered).toMatch(/export class C/);
    expect(rendered).toMatch(/ok: string;/);
    expect(rendered).not.toMatch(/long initializer/);
    expect(rendered).not.toMatch(/protected\s+nope/);
    expect(rendered).not.toMatch(/#secret/);

    // Generic method signature retained; body dropped
    expect(rendered).toMatch(/method<[\s\S]*>\(x\): void;/);
  });

  // --- interface verbatim ---------------------------------------------------

  test("preserves interface declarations verbatim", () => {
    const dir = tmpDir();
    const file = path.join(dir, "types.ts");
    fs.writeFileSync(
      file,
      [
        "export interface User {",
        "  id: number;",
        "  name: string;",
        "  email?: string;",
        "}",
      ].join("\n"),
      "utf8",
    );

    const c = compressFile(file);
    expect(c).toBeTruthy();
    // The full interface text should appear in types
    expect(c!.types.join("\n")).toContain("interface User");
    expect(c!.types.join("\n")).toContain("id: number");
    expect(c!.types.join("\n")).toContain("name: string");
    expect(c!.types.join("\n")).toContain("email?: string");
  });

  // --- type alias verbatim ---------------------------------------------------

  test("preserves type alias declarations verbatim", () => {
    const dir = tmpDir();
    const file = path.join(dir, "alias.ts");
    fs.writeFileSync(
      file,
      'export type Status = "active" | "inactive" | "pending";\n',
      "utf8",
    );

    const c = compressFile(file);
    expect(c).toBeTruthy();
    const typesText = c!.types.join("\n");
    expect(typesText).toContain("type Status");
    expect(typesText).toContain('"active"');
    expect(typesText).toContain('"inactive"');
  });

  // --- enum verbatim --------------------------------------------------------

  test("preserves enum declarations verbatim", () => {
    const dir = tmpDir();
    const file = path.join(dir, "enums.ts");
    fs.writeFileSync(
      file,
      [
        "export enum Direction {",
        "  Up = 'UP',",
        "  Down = 'DOWN',",
        "  Left = 'LEFT',",
        "  Right = 'RIGHT',",
        "}",
      ].join("\n"),
      "utf8",
    );

    const c = compressFile(file);
    expect(c).toBeTruthy();
    const typesText = c!.types.join("\n");
    expect(typesText).toContain("enum Direction");
    expect(typesText).toContain("Up");
    expect(typesText).toContain("Down");
  });

  // --- non-TS file ----------------------------------------------------------

  test("returns undefined for non-TypeScript files", () => {
    const dir = tmpDir();
    const file = path.join(dir, "readme.md");
    fs.writeFileSync(file, "# Hello\n", "utf8");

    const c = compressFile(file);
    expect(c).toBeUndefined();
  });

  // --- file metadata --------------------------------------------------------

  test("compressedChars accurately reflects the length of renderCompressed output", () => {
    const dir = tmpDir();
    const file = path.join(dir, "verify.ts");
    fs.writeFileSync(file, "export function hello(): void {}\n", "utf8");

    const c = compressFile(file)!;
    expect(c.compressedChars).toBe(renderCompressed(c).length);
  });

  test("compressedChars is smaller than originalBytes for a file with large function bodies", () => {
    const dir = tmpDir();
    const file = path.join(dir, "big.ts");
    // A function with 80 lines of body — the compressed form keeps only the signature.
    const bodyLines = Array.from({ length: 80 }, (_, i) => `  const step${i} = i * ${i + 1};`);
    const src = [
      "export function processLargeData(data: number[]): number {",
      ...bodyLines,
      "  return data.reduce((a, b) => a + b, 0);",
      "}",
    ].join("\n");
    fs.writeFileSync(file, src, "utf8");

    const c = compressFile(file)!;
    expect(c.compressedChars).toBeLessThan(c.originalBytes);
  });

  test("exports array lists all top-level export names", () => {
    const dir = tmpDir();
    const file = path.join(dir, "exports.ts");
    fs.writeFileSync(
      file,
      [
        "export const FOO = 1;",
        "export function bar() {}",
        "export class Baz {}",
        "export type Qux = string;",
      ].join("\n"),
      "utf8",
    );

    const c = compressFile(file)!;
    expect(c.exports).toContain("FOO");
    expect(c.exports).toContain("bar");
    expect(c.exports).toContain("Baz");
    expect(c.exports).toContain("Qux");
  });

  // --- renderCompressed -----------------------------------------------------

  test("renderCompressed produces a non-empty string for a valid CompressedFile", () => {
    const dir = tmpDir();
    const file = path.join(dir, "simple.ts");
    fs.writeFileSync(file, "export function hello(): void {}\n", "utf8");

    const c = compressFile(file)!;
    const rendered = renderCompressed(c);
    expect(typeof rendered).toBe("string");
    expect(rendered.length).toBeGreaterThan(0);
  });
});
