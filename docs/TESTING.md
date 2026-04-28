# Testing

ContextOS uses **Vitest** for unit tests. The goal is to keep the core
scheduler (AST parsing/compression, retrieval, prioritization, budgeting,
prompt building) testable in plain Node without requiring a VS Code host.

## Commands

- `npm test` — run the full unit test suite once
- `npm run test:watch` — watch mode
- `npm run coverage` — generate coverage in `coverage/`

## Structure

- Tests live beside code as `src/**/*.test.ts`.
- Vitest is configured in `vitest.config.ts`.
- A minimal runtime mock for the `vscode` module lives in `test/setup.ts`.

## What we test

- `src/ast/parser.test.ts`
  - Ensures `.ts` parsing uses `ScriptKind.TS` (guards against TSX cast breakage).
- `src/ast/compressor.test.ts`
  - Ensures compression captures imports/exports and strips bodies/initializers/private members.
- `src/retrieval/retriever.test.ts`
  - Import-graph depth decay, keyword extraction, bounded header keyword matching.
- `src/context/budgeter.test.ts`
  - Category quotas, spillover, ordering, exclusions.
- `src/context/prioritizer.test.ts`
  - Active file pinning and deterministic ordering on ties.
- `src/prompt/builder.test.ts`
  - Prompt section ordering and omitting empty sections; avoids active-file “double billing”.

## Adding tests safely

- Prefer exercising real files by writing fixtures into a temp directory via `fs.mkdtempSync`.
- Avoid importing `src/commands/**`, `src/ui/**`, or `src/extension.ts` in unit tests; those are integration-layer VS Code glue.
- If you need `ContextStateStore` in a unit test, mock `vscode` APIs first (see `test/setup.ts`).

