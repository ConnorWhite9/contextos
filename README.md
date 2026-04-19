# ContextOS

> Local-first context scheduler for AI coding agents.

ContextOS is a VS Code extension that sits between you and an LLM. Instead of dumping entire files into a prompt, it **schedules context** — selecting, compressing, and prioritizing the parts of your codebase that matter most for a given task, within a hard token budget.

It is not a prompt generator. It is a small, local, transparent operating system for context.

## Why

Coding assistants burn tokens on irrelevant code. The usual failure modes:

- Whole-file dumps that blow past the context window.
- Arbitrary truncation that drops the function you actually need.
- Opaque prompts — you never see what the model saw.

ContextOS addresses this with three ideas:

1. **AST-aware compression** — keep signatures, types, and structure; summarize bodies.
2. **Prioritization** — score each candidate by relevance, import proximity, recency, and file type.
3. **Token budgeting** — allocate tokens across categories (active file, dependencies, summaries, history) and include items highest-score-first until the budget is exhausted.

Everything runs locally. API calls go directly from your machine to the provider you configure. There is no ContextOS backend.

## Architecture

```
src/
  extension.ts            # activation, command registration
  commands/               # command handlers
  context/
    engine.ts             # orchestrator
    prioritizer.ts        # scoring
    budgeter.ts           # token allocation
    state.ts              # invariants / working memory / history
  ast/
    parser.ts             # TS Compiler API wrapper + cache
    compressor.ts         # signatures/types/summaries
  retrieval/
    retriever.ts          # keyword + import-graph
  prompt/
    builder.ts            # structured prompt assembly
  provider/
    adapter.ts            # OpenAI / Anthropic / dry-run
  ui/
    previewPanel.ts       # webview: included/excluded + token breakdown
  utils/                  # logger, tokens, paths, types
```

### Pipeline

```
user command
   │
   ▼
ContextEngine.run(task)
   ├─ gather candidates   (active file, imports, recent edits, keyword hits)
   ├─ AST compress        (cached per file+mtime)
   ├─ prioritize          (score + sort)
   ├─ budget              (allocate per category, drop lowest-priority)
   ├─ build prompt        (Task / Constraints / Types / Functions / Summaries)
   └─ dispatch            (provider.adapter  or  dry-run preview)
```

## Commands

| Command                                         | What it does                                |
| ----------------------------------------------- | ------------------------------------------- |
| `ContextOS: Generate with Optimized Context`    | Build context, send to provider, show reply |
| `ContextOS: Preview Context`                    | Build context, show in preview panel only   |
| `ContextOS: Set API Key`                        | Store provider API key in SecretStorage     |
| `ContextOS: Clear AST Cache`                    | Invalidate compression cache                |

## Settings

| Setting                        | Default                                                                | Purpose                                |
| ------------------------------ | ---------------------------------------------------------------------- | -------------------------------------- |
| `contextos.maxTokens`          | `8000`                                                                 | Hard token budget                      |
| `contextos.budgetSplit`        | `{ activeFile:0.35, dependencies:0.3, summaries:0.2, history:0.15 }`   | Per-category allocation                |
| `contextos.provider`           | `dryrun`                                                               | `openai` \| `anthropic` \| `dryrun`    |
| `contextos.model`              | `gpt-4o-mini`                                                          | Provider-specific model id             |
| `contextos.maxDependencyDepth` | `2`                                                                    | Max transitive import depth            |
| `contextos.maxFilesScanned`    | `200`                                                                  | Cap on files scanned per request       |
| `contextos.dryRun`             | `false`                                                                | Force preview, never call provider     |

## Development

```bash
npm install
npm run compile
```

Then press `F5` to launch the Extension Development Host.

## Non-goals (MVP)

- No embeddings (keyword + import graph only).
- TypeScript / JavaScript only.
- No background execution.

These are deliberately deferred — the goal of the MVP is to prove the scheduler concept with clean boundaries that let embeddings and additional languages slot in later.

## License

MIT
