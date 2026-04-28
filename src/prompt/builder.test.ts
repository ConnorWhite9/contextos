import { describe, expect, test } from "vitest";
import { buildPrompt } from "./builder";
import { BudgetDecision, ContextItem, ContextState } from "../utils/types";

function decision(item: ContextItem, included: boolean): BudgetDecision {
  return { item, included };
}

describe("prompt/builder", () => {
  test("renders stable sections and omits empty ones", () => {
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

    expect(built.prompt).toMatch(/^## Task/);
    expect(built.prompt).toMatch(/## Constraints/);
    expect(built.prompt).toMatch(/## Relevant Types/);
    expect(built.prompt).toMatch(/## Relevant Functions/);
    expect(built.prompt).toMatch(/## Active File/);
    expect(built.prompt).toMatch(/## Dependencies/);
    // Summaries should be omitted because none included
    expect(built.prompt).not.toMatch(/## Summaries/);

    // Active file should not contribute to Relevant Functions/Types (avoids double billing)
    expect(built.prompt).toContain("// /dep.ts");
    expect(built.prompt).not.toContain("// /active.ts");
  });
});

