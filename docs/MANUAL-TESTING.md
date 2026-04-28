# ContextOS — Manual Testing Playbook

Use this checklist before releases, after refactors to `src/context/`, `src/ast/`, `src/retrieval/`, or when preview output looks suspicious.

This is intentionally **thorough**. If you only have 2 minutes, run the **Quick Smoke** section.

---

## Quick Smoke (2–5 minutes)

1. Open a TypeScript repo with at least a few files and relative imports.
2. Run `npm install && npm run compile`.
3. Press `F5` (Extension Development Host).
4. In the Extension Development Host:
   - Run **ContextOS: Preview Context**
   - Enter task: `refactor fetchUser to handle nulls`
5. Confirm the Preview panel shows:
   - Active file (`activeFile`) with score `1.00`
   - Some dependencies (if the active file has relative imports)
   - Included/excluded lists with reasons
   - Token budget bars and a non-empty assembled prompt

If anything fails here, stop and fix before doing deeper runs.

---

## 0) Preconditions / Setup

### Supported environments (MVP)

- **Language**: TypeScript/JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`)
- **No embeddings**: retrieval is import-graph + keyword scan (bounded header)
- **No background execution**: commands are user-triggered only

### Build + run

In the extension repo:

```bash
npm install\npm run compile
```

Then in VS Code:

- Press `F5` to open the Extension Development Host.
- In the Extension Development Host, open the target workspace to test.

### Recommended test workspace

Pick one repo per category:

- **Small**: 20–100 files
- **Medium**: 200–1500 files (closer to real)
- **Weird**: uses path aliases, mixed `.js` + `.ts`, lots of barrel exports, and a couple giant files

---

## 1) Preview Context (core behavior)

### 1.1 Active file selection

**Steps**

1. Open a `.ts` file in the editor.
2. Run **ContextOS: Preview Context**.
3. Provide any task.

**Expected**

- The active file is included under `activeFile`.
- It has score `1.00`.
- Its content in the prompt is the actual current editor buffer (not stale disk contents).

**Notes**

- The active file content is clamped to ~60% of global token budget to prevent it from crowding out everything.

### 1.2 Dependency collection via import graph

**Steps**

1. Ensure the active file has at least one **relative import** like `./x` or `../x`.
2. Set `contextos.maxDependencyDepth = 1`.
3. Preview context.
4. Repeat with `contextos.maxDependencyDepth = 2`.

**Expected**

- At depth 1: direct imports appear in `dependencies`.
- At depth 2: some additional transitive dependencies may appear.
- Dependencies are compressed (imports/types/classes/signatures), not full file bodies.

**Common failure causes**

- If the file only imports **bare modules** (e.g. `react`, `zod`), the MVP import graph intentionally does not pull in node_modules.

### 1.3 Keyword retrieval

**Steps**

1. Choose a function/type name that exists somewhere in the repo but is not directly imported by the active file.
2. Preview with a task containing that keyword.

**Expected**

- Some files show a `keyword-match` reason (especially if the keyword appears in imports/exports at the top of the file).
- Keyword matches should not require scanning full file bodies (performance).

### 1.4 Reasons and transparency

**Steps**

1. Preview any context.
2. Inspect an included item and an excluded item.

**Expected**

- Each item has 1+ human-readable reasons (active/direct import/transitive import/keyword/recent edit).
- Excluded items include `Excluded: …` with a clear reason (budget exhausted or too large).

---

## 2) Budgeting and prompt layout

### 2.1 Category split behavior

**Steps**

1. Set `contextos.maxTokens = 800` (small on purpose).
2. Set `contextos.budgetSplit` to something aggressive, e.g.:
   - activeFile: 0.2
   - dependencies: 0.6
   - summaries: 0.2
   - history: 0.0
3. Preview.

**Expected**

- Token bars roughly match the split.
- If a category has no items, its unused quota spills to others (so budget isn’t wasted).

### 2.2 Active file “double billing” check

**Steps**

1. Preview on a file that exports functions/types.
2. Inspect the assembled prompt.

**Expected**

- The active file appears under **Active File** (full text).
- The active file should **not** also be repeated in `Relevant Types`/`Relevant Functions` (those are meant to summarize dependencies + other context).

### 2.3 Prompt structure sanity

**Expected sections (when data exists)**

- `## Task`
- `## Constraints`
- `## Relevant Types`
- `## Relevant Functions`
- `## Active File`
- `## Dependencies`
- `## Summaries`
- `## Recent Tasks`

**Validation**

- Important structural info (Types/Functions) appears earlier than bodies/summaries.
- Markdown fences are balanced (no broken code blocks).

---

## 3) AST compression correctness (high-value checks)

### 3.1 Function bodies stripped in compressed outputs

**Steps**

1. Preview context.
2. Find a dependency file with methods containing non-trivial code.
3. Inspect its compressed rendering in the prompt (Dependencies section).

**Expected**

- Functions appear as signatures ending in `;`
- No `return …` or method bodies appear in the compressed block

### 3.2 Class shells hide internals

**Steps**

1. Find a dependency file with:
   - `private` or `protected` members
   - `#private` fields
   - property initializers with large expressions
2. Preview and inspect its compressed class shell.

**Expected**

- `private`, `protected`, `#secret` members are omitted
- property initializers are omitted (keep `name?: type;`, drop `= …`)

### 3.3 JSDoc preservation

**Steps**

1. Find a dependency file with JSDoc above a function/class/type.
2. Preview and inspect compressed output.

**Expected**

- JSDoc block appears above the relevant signature/type/class in the compressed output.

### 3.4 Parse resilience on broken syntax

**Steps**

1. Create a temporary file with a syntax error (e.g. missing `}`).
2. Open it and preview.

**Expected**

- Preview still renders (best-effort).
- Output channel logs parse diagnostics (informational).

---

## 4) “Generate with Optimized Context”

### 4.1 Dry run safety

**Steps**

1. Set `contextos.provider = "dryrun"` OR `contextos.dryRun = true`.
2. Run **ContextOS: Generate with Optimized Context**.

**Expected**

- Preview panel opens.
- You get a message indicating it’s dry run.
- No network call is made.

### 4.2 Provider call (optional)

Only do this when you’re ready to test real calls.

**Steps**

1. Set `contextos.provider = "openai"` or `"anthropic"`.
2. Run **ContextOS: Set API Key** and store a key.
3. Run **Generate with Optimized Context**.

**Expected**

- A progress notification appears while calling the provider.
- A new markdown document opens with:
  - `# Task`
  - `# Response`

**Failure modes**

- Missing key should produce a user-friendly warning (not a crash).
- 401/429 errors should surface as an error message with status and a clipped body.

---

## 5) Performance and scaling checks

### 5.1 Large workspace responsiveness

**Steps**

1. Test on a medium repo (hundreds to thousands of TS files).
2. Preview context from a representative file.

**Expected**

- Preview appears quickly (goal: <150ms preprocessing; reality depends on disk).
- You should not observe “scan the whole repo” delays.

**Notes**

- `contextos.maxFilesScanned` caps `findFiles` output; raising it increases work.

### 5.2 Cache behavior

**Steps**

1. Preview once.
2. Preview again without changes.
3. Modify and save a dependency file; preview again.

**Expected**

- Second preview should be faster (AST cache hits).
- After save, the edited file should reflect its new signatures/exports (mtime invalidation).

---

## 6) Settings and edge cases

### 6.1 Multi-root workspace

**Steps**

1. Open a VS Code workspace with 2+ folders.
2. Preview context from a file in folder A that imports folder A code.

**Expected**

- No crashes.
- `findFiles` should include paths from all workspace folders.

### 6.2 No active editor

**Steps**

1. Close all editors (no active file).
2. Run Preview.

**Expected**

- Still produces a prompt with Task + any keyword matches.
- Active file category may be empty (no crash).

### 6.3 Very large active file

**Steps**

1. Open a very large file (thousands of lines).
2. Preview.

**Expected**

- Active file content is truncated/clamped.
- Dependencies/summaries still have some budget left (unless maxTokens is tiny).

---

## 7) Security and hygiene (manual audit)

### 7.1 Secret handling

**Steps**

1. Set an API key.
2. Run generate.
3. Search the Output channel / preview prompt for key material.

**Expected**

- Keys never appear in logs, prompt, preview panel, or generated response doc.

### 7.2 Prompt injection exposure

**Steps**

1. Put an adversarial comment in a file included as dependency or active file (e.g. “Ignore all prior instructions…”).
2. Preview.

**Expected**

- This will appear in the prompt today (MVP). Document this for yourself as a known risk until mitigation is implemented.

---

## Troubleshooting checklist

- **No dependencies**: ensure relative imports (`./x`) exist; MVP ignores node_modules.
- **Everything excluded**: increase `maxTokens` or reduce active file size.
- **Slow previews**: reduce `maxFilesScanned`; confirm import existence checks aren’t hitting disk; test on local disk vs network share.
- **Weird parse results**: `.ts` should parse as `ScriptKind.TS` (legacy `<T>expr` casts should work); check Output channel for parse diagnostics.

