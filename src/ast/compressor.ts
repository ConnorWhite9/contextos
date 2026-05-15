import * as ts from "typescript";
import { parseFile } from "./parser";
import { CompressedFile } from "../utils/types";
import { isTypeScriptLike } from "../utils/paths";

/**
 * AST-aware compression.
 *
 * The rule: preserve anything the caller needs to *use* the file
 * (signatures, types, classes, imports, exports), drop anything they
 * only need to *maintain* it (function bodies, property initializers,
 * private internals).
 *
 * Implementation notes:
 *
 * - We build signatures from node parts (modifiers, name, type params,
 *   params, return type) rather than print-then-strip. The textual
 *   approach misfires on `foo(x = { a: 1 }) { … }` and generics with
 *   object-constraint bounds.
 *
 * - We only walk top-level children. Nested declarations rarely matter
 *   for an API view, and skipping them keeps compression predictable.
 *
 * - We attach leading JSDoc where present. For the LLM this is often the
 *   single highest-value context per token.
 *
 * - We skip `private`/`protected`/`#foo` class members. They're internals;
 *   emitting them is all cost, no value.
 */

const printer = ts.createPrinter({
  removeComments: true,
  newLine: ts.NewLineKind.LineFeed,
  omitTrailingSemicolon: false,
});

export function compressFile(filePath: string): CompressedFile | undefined {
  if (!isTypeScriptLike(filePath)) {
    return undefined;
  }
  const parsed = parseFile(filePath);
  if (!parsed) {
    return undefined;
  }

  const imports: string[] = [];
  const exportNames: string[] = [];
  const signatures: string[] = [];
  const types: string[] = [];
  const classes: string[] = [];

  const source = parsed.sourceFile;

  const visit = (node: ts.Node): void => {
    // Imports: keep raw specifier and any named bindings the file pulls in.
    if (ts.isImportDeclaration(node)) {
      const rendered = renderImport(node, source);
      if (rendered) {
        imports.push(rendered);
      }
      return;
    }

    // Re-exports: `export { x } from './y'` or `export * from './y'`.
    if (ts.isExportDeclaration(node)) {
      const rendered = renderExportDeclaration(node, source);
      if (rendered) {
        signatures.push(rendered);
        if (node.exportClause && ts.isNamedExports(node.exportClause)) {
          for (const el of node.exportClause.elements) {
            exportNames.push(el.name.text);
          }
        }
      }
      return;
    }

    // `export default …`
    if (ts.isExportAssignment(node)) {
      signatures.push(renderExportAssignment(node, source));
      exportNames.push("default");
      return;
    }

    if (ts.isFunctionDeclaration(node) && node.name) {
      signatures.push(withJsDoc(node, source, renderFunctionSignature(node, source)));
      if (isExported(node)) {
        exportNames.push(node.name.text);
      }
      return;
    }

    if (ts.isInterfaceDeclaration(node)) {
      types.push(withJsDoc(node, source, renderInterface(node, source)));
      if (isExported(node)) {
        exportNames.push(node.name.text);
      }
      return;
    }

    if (ts.isTypeAliasDeclaration(node)) {
      types.push(withJsDoc(node, source, printNode(node, source)));
      if (isExported(node)) {
        exportNames.push(node.name.text);
      }
      return;
    }

    if (ts.isEnumDeclaration(node)) {
      types.push(withJsDoc(node, source, printNode(node, source)));
      if (isExported(node)) {
        exportNames.push(node.name.text);
      }
      return;
    }

    if (ts.isClassDeclaration(node) && node.name) {
      classes.push(withJsDoc(node, source, renderClassShell(node, source)));
      if (isExported(node)) {
        exportNames.push(node.name.text);
      }
      return;
    }

    if (ts.isVariableStatement(node) && isExported(node)) {
      for (const decl of node.declarationList.declarations) {
        const rendered = renderExportedVariable(node, decl, source);
        if (rendered) {
          signatures.push(withJsDoc(node, source, rendered));
        }
        if (ts.isIdentifier(decl.name)) {
          exportNames.push(decl.name.text);
        }
      }
      return;
    }
  };

  source.forEachChild(visit);

  const dedupedExports = dedupe(exportNames);
  const summary = buildSummary(filePath, dedupedExports, classes, signatures, types);

  const compressed: CompressedFile = {
    path: filePath,
    mtimeMs: parsed.mtimeMs,
    imports,
    signatures,
    types,
    classes,
    exports: dedupedExports,
    summary,
    originalBytes: parsed.bytes,
    compressedChars: 0,
  };

  // Compute final size after rendering so callers can display a ratio.
  compressed.compressedChars = renderCompressed(compressed).length;
  return compressed;
}

// ---------- Imports / exports ----------

function renderImport(
  node: ts.ImportDeclaration,
  source: ts.SourceFile,
): string | undefined {
  if (!ts.isStringLiteral(node.moduleSpecifier)) {
    return undefined;
  }
  // Print the whole import verbatim — imports are already tiny.
  return printNode(node, source).trim();
}

function renderExportDeclaration(
  node: ts.ExportDeclaration,
  source: ts.SourceFile,
): string | undefined {
  return printNode(node, source).trim();
}

function renderExportAssignment(
  node: ts.ExportAssignment,
  source: ts.SourceFile,
): string {
  // `export default fn` → keep. `export default (big expression)` → drop
  // the expression body; we only care that a default exists.
  const expr = node.expression;
  if (ts.isIdentifier(expr)) {
    return `export default ${expr.text};`;
  }
  if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
    const sig = renderCallableSignature(expr, source);
    return `export default ${sig};`;
  }
  if (ts.isClassExpression(expr)) {
    return `export default class { /* … */ };`;
  }
  return `export default ${printNode(expr, source).split("\n")[0]};`;
}

function renderExportedVariable(
  stmt: ts.VariableStatement,
  decl: ts.VariableDeclaration,
  source: ts.SourceFile,
): string | undefined {
  if (!ts.isIdentifier(decl.name)) {
    return undefined; // destructuring: skip for the MVP
  }
  const keyword = stmt.declarationList.flags & ts.NodeFlags.Const
    ? "const"
    : stmt.declarationList.flags & ts.NodeFlags.Let
      ? "let"
      : "var";

  // If the initializer is a function/arrow, render its callable signature
  // so the prompt shows shape even without an explicit annotation.
  const init = decl.initializer;
  if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
    const sig = renderCallableSignature(init, source);
    return `export ${keyword} ${decl.name.text} = ${sig};`;
  }

  // Otherwise keep the explicit type annotation if one exists; drop the value.
  const typeText = decl.type
    ? `: ${printNode(decl.type, source)}`
    : "";
  return `export ${keyword} ${decl.name.text}${typeText};`;
}

// ---------- Functions ----------

function renderFunctionSignature(
  node: ts.FunctionDeclaration,
  source: ts.SourceFile,
): string {
  const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword) ? "export " : "";
  const defaultMod = hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default " : "";
  const async = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? "async " : "";
  const name = node.name?.text ?? "anonymous";
  const generics = renderTypeParameters(node.typeParameters, source);
  const params = renderParameters(node.parameters, source);
  const ret = node.type ? `: ${printNode(node.type, source)}` : "";
  return `${exported}${defaultMod}${async}function ${name}${generics}(${params})${ret};`;
}

/** For arrow functions and function expressions (used from exported consts). */
function renderCallableSignature(
  node: ts.ArrowFunction | ts.FunctionExpression,
  source: ts.SourceFile,
): string {
  const async = hasModifier(node, ts.SyntaxKind.AsyncKeyword) ? "async " : "";
  const generics = renderTypeParameters(node.typeParameters, source);
  const params = renderParameters(node.parameters, source);
  const ret = node.type ? `: ${printNode(node.type, source)}` : "";
  return `${async}${generics}(${params})${ret} => { /* … */ }`;
}

// ---------- Interfaces ----------

/**
 * Print the interface but strip any private-ish index signatures or
 * whitespace-inflated comments. For the MVP, verbatim print is fine —
 * interfaces are almost always the kind of thing the LLM needs in full.
 */
function renderInterface(
  node: ts.InterfaceDeclaration,
  source: ts.SourceFile,
): string {
  return printNode(node, source);
}

// ---------- Classes ----------

function renderClassShell(
  node: ts.ClassDeclaration,
  source: ts.SourceFile,
): string {
  const exported = hasModifier(node, ts.SyntaxKind.ExportKeyword) ? "export " : "";
  const defaultMod = hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default " : "";
  const abstractMod = hasModifier(node, ts.SyntaxKind.AbstractKeyword) ? "abstract " : "";
  const name = node.name?.text ?? "AnonymousClass";
  const generics = renderTypeParameters(node.typeParameters, source);
  const heritage = node.heritageClauses
    ? " " +
      node.heritageClauses
        .map((h) => printNode(h, source))
        .join(" ")
    : "";

  const memberLines: string[] = [];
  for (const member of node.members) {
    if (isHiddenMember(member)) {
      continue;
    }
    const line = renderClassMember(member, source);
    if (line) {
      memberLines.push(line);
    }
  }

  const body = memberLines.length ? `\n  ${memberLines.join("\n  ")}\n` : "";
  return `${exported}${defaultMod}${abstractMod}class ${name}${generics}${heritage} {${body}}`;
}

function renderClassMember(
  member: ts.ClassElement,
  source: ts.SourceFile,
): string | undefined {
  if (ts.isConstructorDeclaration(member)) {
    const params = renderParameters(member.parameters, source);
    const mods = renderMemberModifiers(member);
    return `${mods}constructor(${params});`;
  }

  if (ts.isMethodDeclaration(member)) {
    const mods = renderMemberModifiers(member);
    const name = printNode(member.name, source);
    const generics = renderTypeParameters(member.typeParameters, source);
    const params = renderParameters(member.parameters, source);
    const ret = member.type ? `: ${printNode(member.type, source)}` : "";
    return `${mods}${name}${generics}(${params})${ret};`;
  }

  if (ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
    const kind = ts.isGetAccessor(member) ? "get" : "set";
    const mods = renderMemberModifiers(member);
    const name = printNode(member.name, source);
    const params = renderParameters(member.parameters, source);
    const ret = member.type ? `: ${printNode(member.type, source)}` : "";
    return `${mods}${kind} ${name}(${params})${ret};`;
  }

  if (ts.isPropertyDeclaration(member)) {
    const mods = renderMemberModifiers(member);
    const name = printNode(member.name, source);
    const typeText = member.type ? `: ${printNode(member.type, source)}` : "";
    const optional = member.questionToken ? "?" : "";
    // Intentionally drop the initializer — we only want shape.
    return `${mods}${name}${optional}${typeText};`;
  }

  if (ts.isIndexSignatureDeclaration(member)) {
    return printNode(member, source);
  }

  return undefined;
}

function isHiddenMember(member: ts.ClassElement): boolean {
  if (ts.isPropertyDeclaration(member) || ts.isMethodDeclaration(member) ||
      ts.isGetAccessor(member) || ts.isSetAccessor(member)) {
    if (member.name && ts.isPrivateIdentifier(member.name)) {
      return true;
    }
  }
  const mods = ts.canHaveModifiers(member) ? ts.getModifiers(member) : undefined;
  if (!mods) {
    return false;
  }
  return mods.some(
    (m) =>
      m.kind === ts.SyntaxKind.PrivateKeyword ||
      m.kind === ts.SyntaxKind.ProtectedKeyword,
  );
}

function renderMemberModifiers(member: ts.ClassElement): string {
  if (!ts.canHaveModifiers(member)) {
    return "";
  }
  const mods = ts.getModifiers(member);
  if (!mods || mods.length === 0) {
    return "";
  }
  const kept = mods
    .filter(
      (m) =>
        m.kind !== ts.SyntaxKind.PrivateKeyword &&
        m.kind !== ts.SyntaxKind.ProtectedKeyword,
    )
    .map((m) => ts.tokenToString(m.kind) ?? "")
    .filter(Boolean);
  return kept.length ? kept.join(" ") + " " : "";
}

// ---------- Shared helpers ----------

function renderParameters(
  params: ts.NodeArray<ts.ParameterDeclaration>,
  source: ts.SourceFile,
): string {
  return params
    .map((p) => {
      // Drop default-value initializers for compactness; keep name + type.
      const dotDot = p.dotDotDotToken ? "..." : "";
      const name = printNode(p.name, source);
      const optional = p.questionToken ? "?" : "";
      const typeText = p.type ? `: ${printNode(p.type, source)}` : "";
      return `${dotDot}${name}${optional}${typeText}`;
    })
    .join(", ");
}

function renderTypeParameters(
  params: ts.NodeArray<ts.TypeParameterDeclaration> | undefined,
  source: ts.SourceFile,
): string {
  if (!params || params.length === 0) {
    return "";
  }
  const rendered = params.map((tp) => printNode(tp, source)).join(", ");
  return `<${rendered}>`;
}

function isExported(node: ts.Node): boolean {
  return hasModifier(node, ts.SyntaxKind.ExportKeyword);
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  if (!ts.canHaveModifiers(node)) {
    return false;
  }
  const mods = ts.getModifiers(node);
  return !!mods?.some((m) => m.kind === kind);
}

function printNode(node: ts.Node, source: ts.SourceFile): string {
  return printer.printNode(ts.EmitHint.Unspecified, node, source);
}

/**
 * Collect the JSDoc block (if any) immediately preceding `node` and
 * prepend it to `rendered`. For LLM context, this doc block is often
 * worth more than all the types combined.
 */
function withJsDoc(node: ts.Node, source: ts.SourceFile, rendered: string): string {
  const jsDocs = (node as unknown as { jsDoc?: ts.JSDoc[] }).jsDoc;
  if (!jsDocs || jsDocs.length === 0) {
    // Fallback: scan leading comment ranges for a /** … */ block.
    const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart());
    if (!ranges || ranges.length === 0) {
      return rendered;
    }
    const blocks = ranges
      .filter((r) => r.kind === ts.SyntaxKind.MultiLineCommentTrivia)
      .map((r) => source.text.slice(r.pos, r.end))
      .filter((text) => text.startsWith("/**"));
    if (blocks.length === 0) {
      return rendered;
    }
    return `${blocks[blocks.length - 1]}\n${rendered}`;
  }
  const last = jsDocs[jsDocs.length - 1];
  return `${printNode(last, source)}\n${rendered}`;
}

function buildSummary(
  filePath: string,
  exports: string[],
  classes: string[],
  signatures: string[],
  types: string[],
): string {
  if (exports.length > 0) {
    const shown = exports.slice(0, 8).join(", ");
    const more = exports.length > 8 ? `, +${exports.length - 8} more` : "";
    return `${filePath}: exports ${shown}${more}.`;
  }

  // Private file — nothing exported. Fall back to a structural summary.
  const parts: string[] = [];
  if (classes.length > 0) {
    parts.push(`${classes.length} class${classes.length === 1 ? "" : "es"}`);
  }
  if (signatures.length > 0) {
    parts.push(`${signatures.length} function${signatures.length === 1 ? "" : "s"}`);
  }
  if (types.length > 0) {
    parts.push(`${types.length} type${types.length === 1 ? "" : "s"}`);
  }
  const shape = parts.length > 0 ? parts.join(", ") : "no top-level declarations";
  return `${filePath}: ${shape}.`;
}

function dedupe(values: string[]): string[] {
  return Array.from(new Set(values));
}

// ---------- Rendering ----------

/**
 * Serialize a CompressedFile into prompt-ready text. Stable layout —
 * sections are omitted rather than reordered when empty, so downstream
 * diffs stay readable across revisions.
 */
export function renderCompressed(c: CompressedFile): string {
  const lines: string[] = [];
  lines.push(`// file: ${c.path}`);
  lines.push(`// summary: ${c.summary}`);
  if (c.imports.length > 0) {
    lines.push("// imports:");
    lines.push(c.imports.join("\n"));
  }
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
