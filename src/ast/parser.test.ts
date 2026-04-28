import { describe, expect, test } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as ts from "typescript";
import { parseFile } from "./parser";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contextos-"));
}

describe("ast/parser", () => {
  test("parses .ts files as TS (legacy <T>expr cast is a TypeAssertionExpression)", () => {
    const dir = tmpDir();
    const file = path.join(dir, "cast.ts");
    fs.writeFileSync(
      file,
      [
        "declare const foo: unknown;",
        "const x = <number>foo;",
      ].join("\n"),
      "utf8",
    );

    const parsed = parseFile(file);
    expect(parsed).toBeTruthy();

    // Find the initializer `const x = <number>foo;`
    const sf = parsed!.sourceFile;
    const stmt = sf.statements
      .filter(ts.isVariableStatement)
      .find((s) =>
        s.declarationList.declarations.some(
          (d) => ts.isIdentifier(d.name) && d.name.text === "x",
        ),
      )!;
    const decl = stmt.declarationList.declarations.find(
      (d) => ts.isIdentifier(d.name) && d.name.text === "x",
    )!;
    const init = decl.initializer;
    expect(init).toBeTruthy();
    expect(init.kind).toBe(ts.SyntaxKind.TypeAssertionExpression);
  });
});

