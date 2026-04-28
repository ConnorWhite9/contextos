# ContextOS — Tasks

Roadmap from the current scaffold to a shippable v1. Ordered top-to-bottom
by recommended sequence. Each task has an owner-friendly scope; check items
off as you go.

---

## P0 — Validate the pipeline end-to-end

Nothing has exercised the full flow against real code yet. Before adding
features, prove the scaffold works.

- [ ] Press `F5`, open a small TS repo in the Extension Development Host.
- [ ] Run `ContextOS: Preview Context` with the task "refactor fetchUser".
- [ ] Verify in the preview panel:
  - [ ] The active file shows up under `activeFile` with score `1.00`.
  - [ ] Direct imports appear under `dependencies` with compressed signatures/types.
  - [ ] Category bars fill proportionally to the configured split.
  - [ ] At least one excluded item has a sensible `excludedBecause` reason.
  - [ ] The assembled prompt renders with all 5 sections (Task / Constraints / Types / Functions / Summaries / Active File / Dependencies).
- [ ] Run `ContextOS: Generate with Optimized Context` in `dryrun` mode; confirm no network call (Output pane shows `[ContextOS dry-run]`).
- [ ] Test `ContextOS: Clear AST Cache` — confirm subsequent runs re-parse.
- [ ] File issues / fixes for anything broken. Likely suspects:
  - Path normalization between `collectWorkspacePaths` (absolute) and `resolveImport` (may return different shape on Windows).
  - `fs.existsSync` in `importGraphWithResolver` could be slow on network drives — consider an in-memory Set from the initial workspace scan.
  - Active file content being both in the `Active File` section *and* contributing signatures to `Relevant Functions` → potential double-billing of tokens.

---

## P1 — Unit tests for the headless core

The engine, budgeter, compressor, prioritizer, and retriever are all pure.
Tests here catch regressions 100x faster than F5 loops.

- [ ] Add `vitest` (or `mocha + @types/mocha`) as a devDependency.
- [ ] Wire `npm test` script + `tsconfig.test.json` that includes `src/**/*.test.ts`.
- [ ] `src/context/budgeter.test.ts`
  - [ ] Respects per-category quotas in priority order.
  - [ ] Spillover: unused quota flows to global headroom.
  - [ ] Too-large-for-category vs global-budget-exhausted reasons are distinct.
  - [ ] Decisions come back in original input order.
- [ ] `src/ast/compressor.test.ts`
  - [ ] Method bodies are stripped; signatures remain.
  - [ ] Interfaces, type aliases, enums are preserved verbatim.
  - [ ] Class shells include properties, constructor, methods (body-less).
  - [ ] Top-level exported `const x: T = …` becomes a signature without initializer.
- [ ] `src/context/prioritizer.test.ts`
  - [ ] Active file pins to score 1.0.
  - [ ] Keyword-in-path adds measurable score.
  - [ ] Recency signal shifts ordering when history is populated.
  - [ ] Deterministic tiebreak by path.
- [ ] `src/retrieval/retriever.test.ts`
  - [ ] Import graph depth decay (1.0, 0.5, 0.25…).
  - [ ] Keyword tokenization strips stopwords + short tokens.
  - [ ] Keyword scoring normalizes to [0, 1].
- [ ] `src/prompt/builder.test.ts`
  - [ ] Sections appear in the required order.
  - [ ] Empty categories are omitted (no dangling headers).
  - [ ] `includedPaths` matches the actual included items.

---

## P2 — Evaluation harness

The thing that turns ContextOS from "a scheduler" into "a scheduler worth using."

- [ ] Create `bench/` directory with a small script runner.
- [ ] Define 3–5 fixture tasks over a medium TS repo (pick one: e.g. a fork of `zod` or `express`).
  - [ ] "Add a field to the User type and propagate it."
  - [ ] "Fix the off-by-one in `paginate`."
  - [ ] "Add unit tests for `parseQuery`."
- [ ] Run three strategies against each task:
  - [ ] `naive-active`: dump only the active file.
  - [ ] `naive-imports`: dump active + all direct imports (uncompressed).
  - [ ] `contextos`: full pipeline.
- [ ] Capture metrics per run: tokens used, elapsed ms, response text.
- [ ] Score response quality against a rubric (correctness, precision, hallucination).
- [ ] Output `bench/report.md` with a comparison table.
- [ ] Use results to **retune prioritizer weights** (`0.55 / 0.2 / 0.15 / 0.1` in `prioritizer.ts`) from guesses to evidence-based.

---

## P3 — Gaps vs the original spec

- [ ] **Incremental watching.** Register `vscode.workspace.createFileSystemWatcher` in `extension.ts`.
  - [ ] On change: invalidate AST cache entry for that path.
  - [ ] On change: mark import graph stale so it rebuilds on next request.
  - [ ] Optionally: pre-warm AST for newly-saved files during idle.
- [ ] **Pluggable token counting.** Make `estimateTokens` a strategy.
  - [ ] Interface: `TokenCounter { count(text: string): number }`.
  - [ ] Default: current char/4 heuristic.
  - [ ] Optional: `tiktoken` for OpenAI, `@anthropic-ai/tokenizer` for Anthropic, selected via config.
- [ ] **Empty-budget fallback verified.** Add test + manual check that preview panel renders sanely when no items survived.
- [ ] **<150ms performance target.** Add a timing assertion in the eval harness that fails CI if engine.run exceeds the target on the fixture repo.

---

## P4 — Product polish

- [ ] **Task input panel.** Replace `showInputBox` with a dedicated webview containing:
  - [ ] Multi-line textarea.
  - [ ] History dropdown (pull from `ContextState.history`).
  - [ ] "Preview" and "Send" buttons inline.
  - [ ] "Dry run" checkbox that overrides the global setting per-invocation.
- [ ] **Streaming provider responses.**
  - [ ] Switch `send()` to return an `AsyncIterable<string>`.
  - [ ] Stream into an untitled markdown buffer as tokens arrive.
  - [ ] Preserve non-streaming path for dryrun.
- [ ] **Cost estimation.** Add a `costPerMTokens` config per model; preview panel shows estimated $.
- [ ] **Clickable paths.** In the preview panel, make each `.path` a `command:vscode.open` link so you can jump to included/excluded files.
- [ ] **Invariants UX.** Add commands:
  - [ ] `ContextOS: Add Invariant` (prompts for text).
  - [ ] `ContextOS: Edit Invariants` (opens a JSON editor on the state).
- [ ] **Bootstrap invariants from repo.** On first activation, scan for `tsconfig.json`, `package.json`, top-level README and offer to seed invariants (e.g. "strict TypeScript", "uses pnpm").

---

## P5 — Extension points (was non-goals, now optional)

Deliberately deferred in the MVP spec, but the seams already exist. Pick up
if and when the eval harness shows the MVP plateauing.

- [ ] **Embedding retriever.**
  - [ ] Add a second `Retriever` implementation under `src/retrieval/embeddings.ts`.
  - [ ] Use `@xenova/transformers` for local embeddings (no server).
  - [ ] Index chunks into a SQLite / in-memory vector store keyed on `(path, mtimeMs)`.
  - [ ] Engine combines keyword + embedding hits the same way it currently combines import-graph + keyword.
- [ ] **Multi-language compression.**
  - [ ] Refactor `compressFile` into a dispatcher keyed on file extension.
  - [ ] Add Python support via `tree-sitter-python`.
  - [ ] Add Go support via `go/ast` JSON export or `tree-sitter-go`.
- [ ] **LLM-generated summaries.**
  - [ ] Add an optional background task that summarizes files via the configured provider.
  - [ ] Cache: `summaryCache[contentHash] = summary`.
  - [ ] Fall back to the deterministic heuristic summary if LLM is unavailable or dryrun.
- [ ] **Feedback loop.** Add thumbs-up/down buttons to the response view; store outcomes keyed on the set of included paths; surface as a weight in the prioritizer.

---

## P6 — Packaging & release

- [ ] Add `images/icon.png` (128x128 PNG).
- [ ] Fill in `publisher` in `package.json` (register at https://marketplace.visualstudio.com/manage).
- [ ] Add `LICENSE` file (MIT, as README claims).
- [ ] Add `CHANGELOG.md` with initial `0.1.0` entry.
- [ ] Run `npx vsce package` and hand-install the `.vsix` to verify `.vscodeignore` isn't stripping anything ship-critical.
- [ ] Add GitHub Actions CI:
  - [ ] `npm ci && npm run compile && npm test` on Node 20 / macOS + Ubuntu + Windows.
  - [ ] Cache `node_modules` by lockfile hash.
- [ ] Publish `0.1.0` to the VS Code Marketplace.
- [ ] Add a `docs/ARCHITECTURE.md` expanding the pipeline diagram in the README with sequence diagrams for the two commands.

---

## P7 — Security & robustness

- [ ] **API key hygiene.** Audit that keys never touch logs or the preview panel. Grep `log.info|log.warn|log.error` for secret leaks.
- [ ] **Prompt injection defense.** Source files can contain adversarial comments ("ignore previous instructions…"). Decide: accept the risk, or sanitize / fence content. Document the choice.
- [ ] **Webview CSP.** `previewPanel.ts` currently has `enableScripts: false` — good. When you add scripts (for the task input panel in P4), add a strict `Content-Security-Policy` meta tag.
- [ ] **Large-file guardrails.** Confirm `clampToTokens` handles files > the full budget without pathological slicing.

---

## Stretch — interesting ideas, not required

- [ ] **Workspace-level scheduler telemetry dashboard.** A "ContextOS: Show Stats" command with a webview showing per-session token savings vs the naive baseline.
- [ ] **Multi-turn agent loop.** Let the model request additional files; the engine serves them from the same budget rather than dumping everything upfront.
- [ ] **CLI.** Since the engine is headless, expose a `contextos` binary that takes a task + workspace root and prints the prompt. Useful for scripting and for users on editors that aren't VS Code.
- [ ] **Cursor Rules export.** Given the `invariants` array, generate a `.cursor/rules/*.mdc` file so the scheduled context lines up with Cursor's own rule system.

---

## Done-definition for v1.0

- Eval harness shows ContextOS beats naive baselines on ≥3 of 5 tasks on both token efficiency and response quality.
- `npm test` covers ≥70% of `src/context/`, `src/ast/`, `src/retrieval/`, `src/prompt/`.
- `<150ms` scheduling target verified in CI on the fixture repo.
- Published to Marketplace with an icon, license, and changelog.
- README includes a 30-second GIF of the preview panel.
