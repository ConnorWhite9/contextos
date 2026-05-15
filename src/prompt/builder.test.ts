import { describe, expect, test } from "vitest";
import { buildPrompt, buildFallbackPrompt } from "./builder";
import { BudgetDecision, ContextItem, ContextState } from "../utils/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function decision(item: ContextItem, included: boolean): BudgetDecision {
  return { item, included };
}

function makeItem(
  category: ContextItem["category"],
  path: string,
  content = "content",
): ContextItem {
  return {
    id: `${category}:${path}`,
    path,
    category,
    content,
    tokens: 10,
    score: 0.9,
    reasons: [],
  };
}

function emptyState(): ContextState {
  return { invariants: [], workingMemory: [], history: [] };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("prompt/builder", () => {
  // --- section ordering and presence ----------------------------------------

  test("renders sections in required order and omits empty ones", () => {
    const state: ContextState = {
      invariants: ["No breaking changes"],
      workingMemory: [],
      history: [],
    };

    const dep: ContextItem = {
      id: "dependencies:/dep.ts",
      path: "/dep.ts",
      category: "dependencies",
      content: "dep content",
      tokens: 10,
      score: 0.9,
      reasons: [],
      compressed: {
        path: "/dep.ts",
        mtimeMs: 1,
        imports: ["import x from 'y';"],
        signatures: ["export function f(): void;"],
        types: ["export type T = number;"],
        classes: [],
        exports: ["f", "T"],
        summary: "/dep.ts: exports f, T.",
        originalBytes: 100,
        compressedChars: 50,
      },
    };

    const active: ContextItem = {
      id: "activeFile:/active.ts",
      path: "/active.ts",
      category: "activeFile",
      content: "export function active() { return 1 }",
      tokens: 10,
      score: 1,
      reasons: [],
    };

    const built = buildPrompt({
      task: "Do the thing",
      decisions: [decision(dep, true), decision(active, true)],
      state,
    });

    // Task first
    expect(built.prompt.indexOf("## Task")).toBeLessThan(built.prompt.indexOf("## Constraints"));
    expect(built.prompt.indexOf("## Constraints")).toBeLessThan(built.prompt.indexOf("## Relevant Types"));
    expect(built.prompt.indexOf("## Relevant Types")).toBeLessThan(built.prompt.indexOf("## Active File"));
    expect(built.prompt.indexOf("## Active File")).toBeLessThan(built.prompt.indexOf("## Dependencies"));

    // Summaries section is absent because no summaries were included
    expect(built.prompt).not.toMatch(/## Summaries/);
  });

  test("omits Constraints section when both invariants and workingMemory are empty", () => {
    const active = makeItem("activeFile", "/a.ts");
    const built = buildPrompt({
      task: "task",
      decisions: [decision(active, true)],
      state: emptyState(),
    });
    expect(built.prompt).not.toMatch(/## Constraints/);
  });

  test("omits Active File section when no active-file item is included", () => {
    const dep = makeItem("dependencies", "/dep.ts");
    const built = buildPrompt({
      task: "task",
      decisions: [decision(dep, true)],
      state: emptyState(),
    });
    expect(built.prompt).not.toMatch(/## Active File/);
  });

  test("omits Dependencies section when no dependency item is included", () => {
    const active = makeItem("activeFile", "/a.ts");
    const built = buildPrompt({
      task: "task",
      decisions: [decision(active, true)],
      state: emptyState(),
    });
    expect(built.prompt).not.toMatch(/## Dependencies/);
  });

  test("omits all optional sections when all decisions are excluded", () => {
    const active = makeItem("activeFile", "/a.ts");
    const built = buildPrompt({
      task: "Nothing survived",
      decisions: [decision(active, false)],
      state: emptyState(),
    });
    // Only Task should appear
    expect(built.prompt).toMatch(/## Task/);
    expect(built.prompt).not.toMatch(/## Active File/);
    expect(built.prompt).not.toMatch(/## Dependencies/);
    expect(built.prompt).not.toMatch(/## Constraints/);
  });

  // --- includedPaths ---------------------------------------------------------

  test("includedPaths contains only the paths of included decisions", () => {
    const a = makeItem("activeFile", "/included.ts");
    const b = makeItem("dependencies", "/excluded.ts");

    const built = buildPrompt({
      task: "t",
      decisions: [decision(a, true), decision(b, false)],
      state: emptyState(),
    });

    expect(built.includedPaths).toContain("/included.ts");
    expect(built.includedPaths).not.toContain("/excluded.ts");
  });

  test("includedPaths is empty when all decisions are excluded", () => {
    const a = makeItem("activeFile", "/a.ts");
    const built = buildPrompt({
      task: "t",
      decisions: [decision(a, false)],
      state: emptyState(),
    });
    expect(built.includedPaths).toEqual([]);
  });

  // --- constraints section --------------------------------------------------

  test("invariants appear in Constraints as bullet points", () => {
    const state: ContextState = {
      invariants: ["Use strict TypeScript", "No breaking changes"],
      workingMemory: [],
      history: [],
    };
    const built = buildPrompt({ task: "t", decisions: [], state });
    expect(built.prompt).toMatch(/## Constraints/);
    expect(built.prompt).toContain("- Use strict TypeScript");
    expect(built.prompt).toContain("- No breaking changes");
  });

  test("working memory notes appear in Constraints with (note) prefix", () => {
    const state: ContextState = {
      invariants: [],
      workingMemory: ["Remember the DB schema changed"],
      history: [],
    };
    const built = buildPrompt({ task: "t", decisions: [], state });
    expect(built.prompt).toMatch(/## Constraints/);
    expect(built.prompt).toContain("- (note) Remember the DB schema changed");
  });

  test("both invariants and working memory appear together in Constraints", () => {
    const state: ContextState = {
      invariants: ["strict mode"],
      workingMemory: ["schema changed"],
      history: [],
    };
    const built = buildPrompt({ task: "t", decisions: [], state });
    expect(built.prompt).toContain("- strict mode");
    expect(built.prompt).toContain("- (note) schema changed");
  });

  // --- history section -------------------------------------------------------

  test("Recent Tasks section appears when history is non-empty", () => {
    const state: ContextState = {
      invariants: [],
      workingMemory: [],
      history: [{ timestamp: 1_000_000, task: "previous task", promptTokens: 100, includedPaths: [] }],
    };
    const built = buildPrompt({ task: "t", decisions: [], state });
    expect(built.prompt).toMatch(/## Recent Tasks/);
    expect(built.prompt).toContain("previous task");
  });

  test("Recent Tasks section is absent when history is empty", () => {
    const built = buildPrompt({ task: "t", decisions: [], state: emptyState() });
    expect(built.prompt).not.toMatch(/## Recent Tasks/);
  });

  test("Recent Tasks shows at most the three most recent entries", () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      timestamp: i * 1_000,
      task: `task-${i}`,
      promptTokens: 10,
      includedPaths: [],
    }));
    const state: ContextState = { invariants: [], workingMemory: [], history: entries };
    const built = buildPrompt({ task: "t", decisions: [], state });
    // Only the last 3 (task-2, task-3, task-4) should appear
    expect(built.prompt).toContain("task-4");
    expect(built.prompt).toContain("task-3");
    expect(built.prompt).toContain("task-2");
    expect(built.prompt).not.toContain("task-0");
    expect(built.prompt).not.toContain("task-1");
  });

  // --- no double-billing of active file -------------------------------------

  test("active file content does not appear in Relevant Types or Relevant Functions", () => {
    const dep: ContextItem = {
      id: "dependencies:/dep.ts",
      path: "/dep.ts",
      category: "dependencies",
      content: "dep body",
      tokens: 10,
      score: 0.9,
      reasons: [],
      compressed: {
        path: "/dep.ts",
        mtimeMs: 1,
        imports: [],
        signatures: ["export function depFn(): void;"],
        types: ["export type DepType = string;"],
        classes: [],
        exports: ["depFn", "DepType"],
        summary: "dep summary",
        originalBytes: 100,
        compressedChars: 50,
      },
    };

    // Active file also has compressed data — it should NOT be lifted into the
    // Relevant Types/Functions sections (double billing prevention).
    const active: ContextItem = {
      id: "activeFile:/active.ts",
      path: "/active.ts",
      category: "activeFile",
      content: "export function activeOnly(): void {}",
      tokens: 10,
      score: 1,
      reasons: [],
      compressed: {
        path: "/active.ts",
        mtimeMs: 1,
        imports: [],
        signatures: ["export function activeOnly(): void;"],
        types: ["export type ActiveType = number;"],
        classes: [],
        exports: ["activeOnly"],
        summary: "active summary",
        originalBytes: 100,
        compressedChars: 50,
      },
    };

    const built = buildPrompt({
      task: "t",
      decisions: [decision(dep, true), decision(active, true)],
      state: emptyState(),
    });

    // dep signatures/types should appear in the Relevant* sections
    expect(built.prompt).toContain("// /dep.ts");
    // active file signatures should NOT appear there (full source is in Active File section)
    expect(built.prompt).not.toContain("// /active.ts");
  });

  // --- fallback prompt -------------------------------------------------------

  test("buildFallbackPrompt returns a minimal prompt with only the Task section", () => {
    const p = buildFallbackPrompt("  my task  ");
    expect(p).toMatch(/^## Task\n/);
    expect(p).toContain("my task");
    // No optional sections
    expect(p).not.toMatch(/## Constraints|## Active File|## Dependencies/);
  });

  // --- token count ----------------------------------------------------------

  test("tokens field is a positive integer proportional to prompt length", () => {
    const built = buildPrompt({ task: "small", decisions: [], state: emptyState() });
    expect(built.tokens).toBeGreaterThan(0);
    expect(Number.isInteger(built.tokens)).toBe(true);
  });

  test("longer task produces higher token estimate", () => {
    const short = buildPrompt({ task: "s", decisions: [], state: emptyState() });
    const long = buildPrompt({ task: "s".repeat(500), decisions: [], state: emptyState() });
    expect(long.tokens).toBeGreaterThan(short.tokens);
  });
});
