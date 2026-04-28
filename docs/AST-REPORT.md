# AST Pipeline — Analysis & Improvements

_Scope:_ `src/ast/parser.ts` + `src/ast/compressor.ts`, and their interactions
with `src/retrieval/retriever.ts` and `src/prompt/builder.ts`.

This document (a) explains how the current AST pipeline works end to end,
(b) enumerates the concrete correctness and quality issues found in the
initial scaffold, and (c) describes the changes we made in this pass and
the ones we consciously deferred.

---

## 1. Pipeline at a glance

```
file path
   │
   ▼
parseFile(path)                                  src/ast/parser.ts
   ├─ fs.statSync      → mtimeMs
   ├─ AstCache.get(path, mtimeMs) → hit? return.
   ├─ fs.readFileSync  → source string
   ├─ ts.createSourceFile(path, source, ScriptTarget.Latest,
   │                      setParentNodes=false, ScriptKind.*)
   └─ AstCache.set(...) → returns { sourceFile, mtimeMs, bytes }
   │
   ▼
compressFile(path)                               src/ast/compressor.ts
   ├─ sourceFile.forEachChild(visit)   ← top-level only
   │    ├─ FunctionDeclaration     → renderFunctionSignature()
   │    ├─ InterfaceDeclaration    → printer.printNode()
   │    ├─ TypeAliasDeclaration    → printer.printNode()
   │    ├─ EnumDeclaration         → printer.printNode()
   │    ├─ ClassDeclaration        → renderClassShell()
   │    └─ VariableStatement       → exported-const signatures
   └─ buildSummary()
   │
   ▼
CompressedFile { path, signatures[], types[], classes[],
                 summary, mtimeMs, originalBytes }
```

`CompressedFile` is the unit the rest of the system handles:

- `retriever.ts` reuses the cached `SourceFile` to extract imports without
  re-parsing.
- `engine.ts` wraps the compressed form in a `ContextItem` and lets the
  budgeter decide whether it survives the token budget.
- `prompt/builder.ts` calls `renderCompressed(c)` to produce the lines
  that eventually go into the model's prompt.

---

## 2. Why `ts.createSourceFile` (not a Program)

The TypeScript compiler API offers two levels:

| API                         | What it gives you            | Cost                     |
| --------------------------- | ---------------------------- | ------------------------ |
| `ts.createSourceFile`       | Syntax tree only             | ~0.5–5 ms per file       |
| `ts.createProgram` + checker | Syntax + types + symbols    | ~50–500 ms whole project |

We deliberately use the cheap one. The scheduler's ≤150 ms target rules
out spinning up a full `Program`. We accept that:

- We can't resolve imports by module-graph semantics (we do it by path +
  extension lookup instead, in `retriever.ts`).
- We can't infer types — if the user omits a return type annotation, our
  signature omits it too.
- We can't cross-check references, follow `typeof`, resolve `import type`.

Those are fine trade-offs at this layer. A future `SymbolProvider` seam
can upgrade to a checker on demand (e.g. only for the active file).

---

## 3. Cache design

Key: `filePath`. Value: `{ mtimeMs, sourceFile, bytes }`. Eviction: LRU,
capacity 512. Invalidation is **mtime-based and lazy** — every `parseFile`
call re-stats the file; if the mtime changed, we throw the old entry away.

Pros:

- No watcher needed.
- Cache can't serve stale content even across VS Code reloads of the
  extension host (first call re-stats).
- O(1) hit path; O(1) amortized eviction.

Cons:

- `statSync` on every call, even if the file was just read 1 ms ago. On
  SMB/NFS mounts that's tens of milliseconds each. Mitigation: add a
  small time-window "trust" cap (e.g. skip stat if the entry is <500 ms
  old). Not done yet — deferred until we see it in profiles.
- We don't pre-warm the cache. An `onDidSaveTextDocument` hook could
  eagerly re-parse saved files during idle time. Listed in `TASKS.md`
  under P3.

---

## 4. Issues found in the initial scaffold

### 4.1 Correctness

- **Textual method-body stripping is fragile.** `stripMethodBody()` in
  `compressor.ts` walked the printed method text looking for the first
  `{` at brace-depth zero and cut everything after it. That misfires on
  any signature whose parameter list or type parameters contain a `{`,
  e.g.:
  ```ts
  foo(x = { a: 1 }): void { return; }
  function bar<T extends { a: number }>(): void { return; }
  ```
  The scanner would cut at the object-literal default or the type
  constraint, producing a broken signature.
  **Fix:** build method/constructor/accessor signatures from the AST
  node's parts (modifiers, name, type params, params, return type)
  directly, the same way `renderFunctionSignature` already does for
  free-standing functions. No text scanning.

- **`ScriptKind` was hard-coded to TSX.** Passing `ScriptKind.TSX` for
  every file (including `.ts` and `.js`) made the parser interpret
  `<Foo>x` as JSX, which breaks legacy TypeScript cast syntax (`<T>expr`)
  in `.ts` files.
  **Fix:** infer `ScriptKind` from the extension (`.ts` → `TS`, `.tsx` →
  `TSX`, `.js` → `JS`, `.jsx` → `JSX`, `.d.ts` → `TS`).

- **Parse diagnostics were ignored.** `ts.createSourceFile` always
  returns a tree, even for broken input. We were silently compressing
  partial trees.
  **Fix:** surface `sourceFile.parseDiagnostics` through the logger (info
  level — we still return the partial AST, because a best-effort compression
  is better than nothing for the LLM).

### 4.2 Missing structural elements

The top-level visitor recognized `FunctionDeclaration`, `InterfaceDeclaration`,
`TypeAliasDeclaration`, `EnumDeclaration`, `ClassDeclaration`, and exported
`VariableStatement`. It dropped:

- **`ImportDeclaration`** — which is arguably the single most useful
  compressed artifact: "what does this file depend on?" Now captured as a
  dedicated `imports: string[]` field on `CompressedFile`.
- **`ExportAssignment`** (`export default expr`) — common in utility files,
  previously invisible.
- **`ExportDeclaration`** with `moduleSpecifier` (`export { foo } from './bar'`)
  — re-exports were silently dropped. Now emitted as signatures.
- **Arrow-function consts.** `export const foo = (x: number) => x + 1` was
  handled only if it had an explicit `: T = …` annotation; otherwise it
  emitted as `export const foo` with no shape. Now we detect an arrow /
  function expression initializer and render its parameter list + return
  type as if it were a function declaration.
- **JSDoc comments.** `createPrinter({ removeComments: false })` does not
  emit leading JSDoc for syntactic printing. We now grab JSDoc via
  `ts.getJSDocCommentRanges` / `node.jsDoc` and prepend it to the rendered
  signature. For an LLM this is often the single highest-value context per
  token.
- **`ModuleDeclaration`** (ambient `namespace` / `declare module`) — still
  not emitted. Deferred; rare in modern code.

### 4.3 Class shells leaked internals

- **Private/protected members were emitted.** A class shell that exposes
  `private _cache` or `protected doThing()` adds tokens without API value.
  **Fix:** filter out members whose modifiers include `private` or
  `protected`, and members whose name is a `PrivateIdentifier` (`#foo`).

- **Property initializers were printed verbatim.** `x = someLongExpression`
  emitted the whole expression. For a compressed view we only want
  `x: T;` — the type and declaration, not the value.
  **Fix:** strip initializers from property declarations during rendering.

- **Decorators were kept.** Verbose decorators (e.g. `@Injectable({ …100 chars… })`)
  inflated the output. We keep them (they're often semantically important
  — DI, HTTP routes) but render them compactly on one line above the member.

### 4.4 Rendering details

- **Printer was re-created per compression call.** Cheap, but wasteful —
  hoisted to module scope.
- **Summary was structural, not semantic.** `"3 classes, 5 functions, 2 types"`
  is less useful than the actual export names. The new summary names up to
  8 exports: `"userService.ts: exports UserService, createUser, updateUser, …"`.
- **`originalBytes` was stored but never rendered.** Now exposed in
  `renderCompressed` as a compression ratio comment, which the preview
  panel can surface.

### 4.5 Minor

- Unused `e` in a `catch (e)` in `parser.ts` — changed to `catch`.
- `log.warn` on file read failure but silent on stat failure — standardized.

---

## 5. Changes landed in this pass

| File                       | Change                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `src/ast/parser.ts`        | ScriptKind inferred from extension; parse diagnostics logged; printer no longer needed here. |
| `src/ast/compressor.ts`    | AST-level body stripping; imports, default exports, re-exports, arrow-consts captured; JSDoc prepended; visibility-filtered class shells; named-exports summary; printer hoisted. |
| `src/utils/types.ts`       | `CompressedFile` grows `imports: string[]`, `exports: string[]`, `compressedChars: number`. |
| `src/prompt/builder.ts`    | `renderCompressed` renders the new fields.                                             |

The public surface (`compressFile`, `parseFile`, `renderCompressed`,
`clearAstCache`) is unchanged in shape — only the richness of the output
improved.

---

## 6. Known limitations (intentionally deferred)

These are real but low enough ROI that we're not fixing them in this pass.
They're listed so future work has a clear target.

1. **No type inference.** We only know the types the user wrote. A future
   "deep compression" mode could spin up a `ts.createProgram` for the
   active file's direct imports and feed back inferred return types. Cost:
   tens to low hundreds of ms; only worth it for the active file.

2. **No module-graph resolution via checker.** We still rely on path +
   extension lookup in `retriever.ts`. Path aliases from `tsconfig.json`
   (`paths: { "@/*": ["src/*"] }`) are not honoured. Straight port of TS's
   resolver into `retriever.ts` is the right follow-up.

3. **`namespace` / `declare module` blocks** are skipped. They'd need a
   small recursive visit inside those blocks. Rare in modern codebases.

4. **JSX children aren't summarized.** If a `.tsx` file's main value is
   the component tree it renders, our compression misses it — we keep the
   component's parameter/return types but not its output shape.

5. **Non-TS languages.** Python, Go, Rust etc. are out of scope for the
   MVP. `compressor.ts` would need a dispatch on file extension.

6. **No stable ID for incremental invalidation.** If we add a watcher
   that pre-warms the cache, we'll want a content-hash-based ID (not just
   mtime) so that "touch without change" doesn't invalidate.

---

## 7. How to verify the changes

1. Open any non-trivial `.ts` file in the Extension Development Host.
2. Run `ContextOS: Preview Context`.
3. Expand one of the `dependencies` items in the preview panel and
   confirm that:
   - Imports are listed.
   - JSDoc above functions appears in `signatures`.
   - Class shells contain public members only, property initializers are
     gone, and method bodies are replaced by `;`.
   - The summary includes the actual export names.
4. Run `ContextOS: Clear AST Cache`, confirm that the next preview
   repopulates and that no parse-diagnostic warnings appear in the
   `ContextOS` output channel for healthy files.

Broken syntax: open a file with a deliberate missing `}`. The preview
should still render (best-effort) and the output channel should show a
`parseFile: N diagnostics` line.
