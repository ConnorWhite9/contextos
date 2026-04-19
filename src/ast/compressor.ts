import * as ts from "typescript";
import { parseFile } from "./parser";
import { CompressedFile } from "../utils/types";

/**
 * AST-aware compression.
 *
 * The rule: preserve anything the caller needs to *use* the file
 * (signatures, types, classes), drop anything they only need to *maintain*
 * it (function bodies, internals). This is what buys us ~5–10x shrink on
 * real TS files while keeping the LLM's understanding of the API intact.
 *
 * Output is plain strings rather than nodes so downstream budgeting can
 * work purely with token counts.
 */

export function compressFile(filePath: string): CompressedFile | undefined {
  const parsed = parseFile(filePath);
  if (!parsed) {
    return undefined;
  }

  const signatures: string[] = [];
  const types: string[] = [];
  const classes: string[] = [];

  const printer = ts.createPrinter({
    removeComments: false,
    newLine: ts.NewLineKind.LineFeed,
  });

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name) {
      signatures.push(renderFunctionSignature(node, printer, parsed.sourceFile));
    } else if (ts.isInterfaceDeclaration(node)) {
      types.push(printer.printNode(ts.EmitHint.Unspecified, node, parsed.sourceFile));
    } else if (ts.isTypeAliasDeclaration(node)) {
      types.push(printer.printNode(ts.EmitHint.Unspecified, node, parsed.sourceFile));
    } else if (ts.isEnumDeclaration(node)) {
      types.push(printer.printNode(ts.EmitHint.Unspecified, node, parsed.sourceFile));
    } else if (ts.isClassDeclaration(node) && node.name) {
      classes.push(renderClassShell(node, printer, parsed.sourceFile));
    } else if (ts.isVariableStatement(node)) {
      const exported = node.modifiers?.some(
        (m) => m.kind === ts.SyntaxKind.ExportKeyword,
      );
      if (exported) {
        // Preserve exported `const foo: Type = …` as a signature (strip initializer).
        for (const decl of node.declarationList.declarations) {
          if (ts.isIdentifier(decl.name)) {
            const typeText = decl.type
              ? `: ${printer.printNode(ts.EmitHint.Unspecified, decl.type, parsed.sourceFile)}`
              : "";
            signatures.push(`export const ${decl.name.text}${typeText}`);
          }
        }
      }
    }
    // Only walk top-level — nested declarations rarely matter for an API view,
    // and skipping them keeps compression fast and predictable.
  };

  parsed.sourceFile.forEachChild(visit);

  const summary = buildSummary(filePath, signatures, types, classes);

  return {
    path: filePath,
    mtimeMs: parsed.mtimeMs,
    signatures,
    types,
    classes,
    summary,
    originalBytes: parsed.bytes,
  };
}

function renderFunctionSignature(
  node: ts.FunctionDeclaration,
  printer: ts.Printer,
  source: ts.SourceFile,
): string {
  const name = node.name?.text ?? "anonymous";
  const params = node.parameters
    .map((p) => printer.printNode(ts.EmitHint.Unspecified, p, source))
    .join(", ");
  const ret = node.type
    ? `: ${printer.printNode(ts.EmitHint.Unspecified, node.type, source)}`
    : "";
  const async = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    ? "async "
    : "";
  const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ? "export "
    : "";
  const generics = node.typeParameters
    ? `<${node.typeParameters
        .map((tp) => printer.printNode(ts.EmitHint.Unspecified, tp, source))
        .join(", ")}>`
    : "";
  return `${exported}${async}function ${name}${generics}(${params})${ret}`;
}

/**
 * A class "shell": class header + member signatures, no method bodies.
 * We print each member individually so we can strip `.body` from methods.
 */
function renderClassShell(
  node: ts.ClassDeclaration,
  printer: ts.Printer,
  source: ts.SourceFile,
): string {
  const name = node.name?.text ?? "AnonymousClass";
  const heritage = node.heritageClauses
    ? " " +
      node.heritageClauses
        .map((h) => printer.printNode(ts.EmitHint.Unspecified, h, source))
        .join(" ")
    : "";
  const exported = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
    ? "export "
    : "";
  const abstractMod = node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AbstractKeyword)
    ? "abstract "
    : "";

  const memberLines: string[] = [];
  for (const member of node.members) {
    if (ts.isMethodDeclaration(member) || ts.isConstructorDeclaration(member)) {
      // Print the whole member, then strip its body block textually. This is
      // simpler and more robust than trying to rewrite the AST via
      // `ts.factory.update*` for every kind of method/constructor.
      const printed = printer.printNode(
        ts.EmitHint.Unspecified,
        member,
        source,
      );
      memberLines.push(stripMethodBody(printed));
    } else if (ts.isPropertyDeclaration(member)) {
      memberLines.push(
        printer.printNode(ts.EmitHint.Unspecified, member, source),
      );
    } else if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
      memberLines.push(
        stripMethodBody(
          printer.printNode(ts.EmitHint.Unspecified, member, source),
        ),
      );
    }
  }

  const body = memberLines.length ? `\n  ${memberLines.join("\n  ")}\n` : "";
  return `${exported}${abstractMod}class ${name}${heritage} {${body}}`;
}

/**
 * Given a printed method/accessor like `foo(x: number): string { … }`,
 * replace the `{ … }` body with `;`. We scan for the first `{` after the
 * signature at brace-depth 0 and cut the rest; cheap and robust enough.
 */
function stripMethodBody(printed: string): string {
  let depth = 0;
  for (let i = 0; i < printed.length; i++) {
    const ch = printed[i];
    if (ch === "{" && depth === 0) {
      return printed.slice(0, i).trimEnd() + ";";
    }
    if (ch === "{") {
      depth++;
    } else if (ch === "}") {
      depth--;
    }
  }
  return printed;
}

/**
 * Heuristic one-liner summary. For the MVP we avoid LLM round-trips at
 * compression time — that would defeat the point of a local scheduler.
 * The summary is deterministic and cheap; a future pass can swap this
 * for a cached LLM summary keyed on content hash.
 */
function buildSummary(
  filePath: string,
  signatures: string[],
  types: string[],
  classes: string[],
): string {
  const parts: string[] = [];
  if (classes.length > 0) {
    parts.push(`${classes.length} class${classes.length === 1 ? "" : "es"}`);
  }
  if (signatures.length > 0) {
    parts.push(
      `${signatures.length} function${signatures.length === 1 ? "" : "s"}`,
    );
  }
  if (types.length > 0) {
    parts.push(`${types.length} type${types.length === 1 ? "" : "s"}`);
  }
  const shape = parts.length > 0 ? parts.join(", ") : "no top-level exports";
  return `${filePath}: ${shape}.`;
}

/** Serialize a CompressedFile for inclusion in a prompt. */
export function renderCompressed(c: CompressedFile): string {
  const lines: string[] = [];
  lines.push(`// file: ${c.path}`);
  lines.push(`// summary: ${c.summary}`);
  if (c.types.length > 0) {
    lines.push("// types:");
    lines.push(c.types.join("\n"));
  }
  if (c.classes.length > 0) {
    lines.push("// classes:");
    lines.push(c.classes.join("\n"));
  }
  if (c.signatures.length > 0) {
    lines.push("// functions:");
    lines.push(c.signatures.join("\n"));
  }
  return lines.join("\n");
}
