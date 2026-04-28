# ContextOS — P0 Smoke Test

This is the minimal “does the scheduler work?” checklist. Run it after any
change to `src/context/`, `src/ast/`, or `src/retrieval/`.

## Setup

- Open this repo in VS Code.
- Run `npm install` and `npm run compile`.
- Press `F5` to launch the **Extension Development Host**.

## Test 1 — Preview pipeline

1. In the Extension Development Host, open a TypeScript file with at least
   one relative import (e.g. `import { x } from './x'`).
2. Run `ContextOS: Preview Context`.
3. Enter a task like: `refactor fetchUser to handle nulls`.

### Expected (Preview panel)

- **Active file pinned**
  - Active file appears under `activeFile`
  - Score is `1.00`
- **Dependencies discovered**
  - Direct imports show up under `dependencies`
  - Transitive imports may appear depending on `contextos.maxDependencyDepth`
- **AST compression visible**
  - Dependency entries are compressed: imports, types, class shells, function signatures
  - Class shells contain **no method bodies**
  - JSDoc blocks appear above signatures when present
- **Budget transparency**
  - Token bars show `used` vs `allocated` per category
  - At least one exclusion is visible in non-trivial repos
  - Exclusions include a clear `Excluded: …` reason
- **Prompt structure**
  - Prompt contains (when present): `Task`, `Constraints`, `Relevant Types`, `Relevant Functions`,
    `Active File`, `Dependencies`, `Summaries`, `Recent Tasks`

## Test 2 — Generate in dry run

1. Ensure setting `contextos.provider` is `dryrun` (default) or set `contextos.dryRun = true`.
2. Run `ContextOS: Generate with Optimized Context`.

### Expected

- A preview panel still opens.
- A notification indicates **dry run**.
- No outbound request occurs (no provider errors; Output channel may show a dry-run message).

## Test 3 — AST cache invalidation

1. Run `ContextOS: Preview Context` on a file.
2. Run `ContextOS: Clear AST Cache`.
3. Run `ContextOS: Preview Context` again.

### Expected

- The preview still renders and includes the same files (subject to budgets).
- Output channel logs `AST cache cleared`.

## Troubleshooting quick hits

- **No dependencies found**
  - Check that the active file uses **relative imports** (`./x`) — bare imports (`react`) are intentionally ignored by import-graph retrieval in the MVP.
  - Check `contextos.maxDependencyDepth` is ≥ 1.
- **Active file is huge and crowds out everything**
  - Active file is clamped to 60% of `contextos.maxTokens` by design.
  - Lower `maxTokens` to force exclusions for debugging.
- **Performance regression**
  - Import-graph existence checks should be using the in-memory workspace path set (no `fs.existsSync`).
  - Keyword retrieval reads only the first ~8 KB of each file header; if you changed that, re-check latency.

