import { describe, expect, test } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { compressFile, renderCompressed } from "./compressor";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contextos-"));
}

describe("ast/compressor", () => {
  test("captures imports, exports, jsdoc, and strips bodies/initializers/private members", () => {
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

    // export names should include `add`, `fn`, `C`, and default
    expect(c!.exports).toContain("add");
    expect(c!.exports).toContain("fn");
    expect(c!.exports).toContain("C");
    expect(c!.exports).toContain("default");

    const rendered = renderCompressed(c!);
    // JSDoc should be included above add signature
    expect(rendered).toMatch(/\/\*\*[\s\S]*Adds two numbers\.[\s\S]*\*\//);
    // function bodies should not appear
    expect(rendered).toMatch(/export function add\(a: number, b: number\): number;/);
    expect(rendered).not.toMatch(/return a \+ b/);

    // class shell should not include protected method or private field or initializer string
    expect(rendered).toMatch(/export class C/);
    expect(rendered).toMatch(/ok: string;/);
    expect(rendered).not.toMatch(/long initializer/);
    expect(rendered).not.toMatch(/protected\\s+nope/);
    expect(rendered).not.toMatch(/#secret/);

    // method signature should survive generics/default value with object literal
    expect(rendered).toMatch(/method<[\s\S]*>\(x\): void;/);
  });
});

