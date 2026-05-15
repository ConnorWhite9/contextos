# ContextOS CLI — Pipelines & Workflows

ContextOS schedules context from your codebase and hands the assembled prompt to whatever tool you choose. This document explains how to set up the pipe targets and shows concrete workflows you can run right now.

---

## Quick setup

```bash
# 1. Compile (required after any code change)
npm run compile

# 2. Install globally (one-time — gives you `contextos` in any shell)
npm link

# 3. Verify
contextos --version
```

If you don't want a global install, use the wrapper script instead:

```bash
./ctx "task"        # shorthand for node ./out/cli/index.js "task"
```

---

## Setting workspace defaults

Create `.contextos.json` in your project root. CLI flags always override it.

```json
{
  "activeFile": "src/api/user.ts",
  "pipe":       "claude",
  "maxTokens":  12000,
  "maxDepth":   3
}
```

| Field | Type | What it sets |
|---|---|---|
| `activeFile` | `string` | Default focal file (relative to workspace root) |
| `pipe` | `string` | Default pipe target — see table below |
| `maxTokens` | `number` | Token budget (default `8000`) |
| `maxFiles` | `number` | Max workspace files scanned (default `200`) |
| `maxDepth` | `number` | Max transitive import depth (default `2`) |
| `provider` | `string` | `openai` \| `anthropic` \| `dryrun` |
| `model` | `string` | Model identifier (default `gpt-4o-mini`) |

> Add `.contextos.json` to `.gitignore` if it contains personal preferences, or check it in as a shared team default.

---

## Pipe targets

The `--pipe` flag (or `"pipe"` in config) accepts a **named shorthand** or **any shell command**.

### Named shorthands

| Name | Expands to | Platform |
|---|---|---|
| `claude` | `claude` | macOS / Linux — [Claude Code](https://docs.anthropic.com/en/docs/claude-code/getting-started) |
| `pbcopy` | `pbcopy` | macOS clipboard |
| `xclip` | `xclip -selection clipboard` | Linux / X11 clipboard |
| `xsel` | `xsel --clipboard --input` | Linux / X11 clipboard (alt) |
| `wl-copy` | `wl-copy` | Linux / Wayland clipboard |
| `clip` | `clip` | Windows clipboard |

### Custom commands

Anything not in the table is passed directly to the shell:

```bash
contextos "task" --pipe "llm prompt -"
contextos "task" --pipe "my-ai-cli --stdin --model gpt-4o"
contextos "task" --pipe "tee prompt.txt | llm"
```

---

## Provider setup

### Claude Code (recommended)

Install the Claude CLI, then:

```bash
# Option A — inline pipe
contextos "task" | claude

# Option B — declare in the flag
contextos "task" --pipe claude

# Option C — set in config (never type it again)
echo '{"pipe":"claude"}' > .contextos.json
contextos "task"
```

### OpenAI (direct API)

```bash
export OPENAI_API_KEY=sk-...
contextos "task" -p openai --send
# or with a specific model:
contextos "task" -p openai -m gpt-4o --send
```

### Anthropic (direct API)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
contextos "task" -p anthropic -m claude-opus-4-5 --send
```

### Clipboard → paste anywhere

```bash
# macOS
contextos "task" --pipe pbcopy
# then ⌘V into Cursor, Claude.ai, ChatGPT, etc.

# Linux
contextos "task" --pipe xclip
```

### `llm` CLI (Simon Willison's tool — works with any model)

```bash
pip install llm
llm install llm-claude-3   # or any plugin
contextos "task" | llm -m claude-3-5-sonnet
```

---

## Example workflows

### 1. Focused refactor with Claude Code

You're refactoring `engine.ts`. Tell ContextOS which file to focus on, let it build the context, pipe straight into Claude:

```bash
contextos "refactor ContextEngine to use dependency injection" \
  -f src/context/engine.ts \
  --pipe claude
```

With config (set once):

```json
{ "activeFile": "src/context/engine.ts", "pipe": "claude" }
```

```bash
contextos "refactor ContextEngine to use dependency injection"
```

---

### 2. Bug fix — tighten the token budget

When you want the model to focus on a small area, reduce `maxTokens` so ContextOS only pulls the most relevant code:

```bash
contextos "fix the off-by-one in the depth decay formula" \
  -f src/retrieval/retriever.ts \
  --max-tokens 4000 \
  --pipe claude
```

---

### 3. Write tests for a module

```bash
contextos "write unit tests for the budgeter — cover spillover, zero-split, and distinct exclusion reasons" \
  -f src/context/budgeter.ts \
  --pipe claude
```

---

### 4. Inspect what context was assembled (debug run)

Before sending to any model, check which files were included, their scores, and how the token budget was spent:

```bash
# Rich terminal view (no model call)
contextos "add caching to the AST parser" -f src/ast/parser.ts

# Machine-readable JSON — pipe to jq for filtering
contextos "add caching" -f src/ast/parser.ts --json | \
  jq '.decisions[] | select(.included) | {path: .item.path, score: .item.score, tokens: .item.tokens}'
```

---

### 5. Copy prompt to clipboard, paste into a web UI

Useful for Claude.ai, ChatGPT, Gemini, or any browser-based tool:

```bash
# macOS
contextos "add error handling to all API routes" \
  -f src/api/router.ts \
  --pipe pbcopy

# Linux
contextos "add error handling to all API routes" \
  -f src/api/router.ts \
  --pipe xclip
```

---

### 6. Diff prompt output across branches (CI / code review)

Check whether a change to the codebase affected what context ContextOS would schedule for a common task:

```bash
# On main
contextos "add pagination to the user list" -f src/api/users.ts > prompt-main.txt

# Switch branch, then:
contextos "add pagination to the user list" -f src/api/users.ts > prompt-branch.txt

diff prompt-main.txt prompt-branch.txt
```

---

### 7. Point at a different repo

ContextOS is not tied to the current directory. Pass any workspace root:

```bash
contextos "add rate limiting to all endpoints" \
  -w ~/projects/my-api \
  -f src/middleware/auth.ts \
  --pipe claude
```

---

### 8. Multi-step session — history builds up automatically

Each run records which files were included. On subsequent calls, ContextOS boosts recently seen files via the recency signal in the prioritizer — no extra flags needed:

```bash
# Run 1: introduces context/engine.ts into history
contextos "add request timeout to the provider adapter" -f src/provider/adapter.ts --pipe claude

# Run 2: recency signal now boosts adapter.ts and its imports
contextos "add retry logic to the same adapter" -f src/provider/adapter.ts --pipe claude
```

---

### 9. Dry-run before committing to a model call

Always preview first, send only when satisfied:

```bash
# Step 1: preview (default — no model called)
contextos "migrate storage from localStorage to IndexedDB" -f src/storage/client.ts

# Step 2: send when the context looks right
contextos "migrate storage from localStorage to IndexedDB" -f src/storage/client.ts --pipe claude
```

---

## Cheat sheet

```bash
# Simplest possible run
./ctx "task"

# With a focal file
./ctx "task" -f src/path/to/file.ts

# Pipe to Claude Code
./ctx "task" | claude
./ctx "task" --pipe claude

# Copy to clipboard (macOS)
./ctx "task" --pipe pbcopy

# Inspect context as JSON
./ctx "task" --json | jq .

# Direct OpenAI call
OPENAI_API_KEY=sk-... ./ctx "task" -p openai --send

# Override token budget
./ctx "task" --max-tokens 4000

# Point at another repo
./ctx "task" -w ~/projects/other-repo -f src/main.ts
```

---

## Troubleshooting

**`claude: command not found`**
Install the Claude CLI: https://docs.anthropic.com/en/docs/claude-code/getting-started

**`pbcopy`/`xclip` does nothing after piping**
Make sure you're running from an interactive terminal session, not a remote SSH session without display forwarding.

**Budget shows `↑ prompt overhead`**
The assembled prompt (including section headers and markdown fences) is larger than the item-level token budget. Lower `--max-tokens` slightly — the budgeter will cut lower-priority items until the overhead fits.

**Files you expect are missing from context**
Run with `--json` and inspect `decisions[]` — items excluded by the budgeter have an `excludedBecause` field explaining why. Increase `--max-tokens`, `--max-depth`, or `--max-files` as appropriate.
