import { describe, expect, test } from "vitest";
import { budget } from "./budgeter";
import { ContextItem } from "../utils/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function item(
  id: string,
  category: ContextItem["category"],
  tokens: number,
  score: number,
): ContextItem {
  return {
    id,
    path: `/p/${id}.ts`,
    category,
    content: "x",
    tokens,
    score,
    reasons: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context/budgeter", () => {
  // --- quota + spillover ----------------------------------------------------

  test("respects per-category quotas and spills unused headroom", () => {
    const items: ContextItem[] = [
      item("a1", "activeFile", 30, 0.9),
      item("d1", "dependencies", 25, 0.8),
      item("d2", "dependencies", 25, 0.7),
      // summaries quota is 0, but spillover can include if headroom allows
      item("s1", "summaries", 10, 0.6),
    ];

    const out = budget({
      items,
      maxTokens: 100,
      split: {
        activeFile: 0.3,   // 30 tokens
        dependencies: 0.25, // 25 tokens
        summaries: 0,
        history: 0.45,     // 45 tokens (unused, becomes spillover headroom)
      },
    });

    const included = out.decisions.filter((d) => d.included).map((d) => d.item.id);
    expect(included).toContain("a1");
    expect(included).toContain("d1");
    expect(included).toContain("d2"); // d2 fits in spillover (45 token headroom)
    expect(included).toContain("s1"); // s1 also fits in spillover
    expect(out.totalUsed).toBe(90);
  });

  test("excludes items when the global budget is exhausted", () => {
    const items: ContextItem[] = [
      item("a1", "activeFile", 60, 1),
      item("d1", "dependencies", 50, 0.9),
    ];
    const out = budget({
      items,
      maxTokens: 80,
      split: { activeFile: 0.5, dependencies: 0.5, summaries: 0, history: 0 },
    });

    const a1 = out.decisions.find((d) => d.item.id === "a1")!;
    const d1 = out.decisions.find((d) => d.item.id === "d1")!;
    expect(a1.included).toBe(true);
    expect(d1.included).toBe(false);
    // The reason string is one of the two possible values.
    expect(d1.excludedBecause).toMatch(/Global token budget exhausted|Too large/);
  });

  test("preserves decision ordering matching input order", () => {
    const items: ContextItem[] = [
      item("x", "dependencies", 10, 0.1),
      item("y", "dependencies", 10, 0.2),
      item("z", "dependencies", 10, 0.3),
    ];
    const out = budget({
      items,
      maxTokens: 15,
      split: { activeFile: 0, dependencies: 1, summaries: 0, history: 0 },
    });
    expect(out.decisions.map((d) => d.item.id)).toEqual(["x", "y", "z"]);
  });

  // --- distinct exclusion reasons -------------------------------------------

  test("'too large for category' and 'global budget exhausted' are distinct reasons", () => {
    // a1 fills the activeFile quota, d1 fills the dep quota → 0 headroom.
    // d_huge (tokens > dep quota) is too large for dep even on its own.
    // d_small (tokens < dep quota) could have fit but the global budget is gone.
    const items: ContextItem[] = [
      item("a1", "activeFile", 25, 1.0),
      item("d1", "dependencies", 25, 0.9),
      item("d_huge", "dependencies", 30, 0.8),
      item("d_small", "dependencies", 5, 0.7),
    ];
    const out = budget({
      items,
      maxTokens: 50,
      split: { activeFile: 0.5, dependencies: 0.5, summaries: 0, history: 0 },
    });

    const dHuge = out.decisions.find((d) => d.item.id === "d_huge")!;
    const dSmall = out.decisions.find((d) => d.item.id === "d_small")!;

    expect(dHuge.included).toBe(false);
    expect(dHuge.excludedBecause).toMatch(/Too large for dependencies quota/);

    expect(dSmall.included).toBe(false);
    expect(dSmall.excludedBecause).toBe("Global token budget exhausted");
  });

  // --- edge cases: zero / degenerate splits ---------------------------------

  test("all-zero split falls back to even distribution without throwing", () => {
    const items: ContextItem[] = [item("a", "activeFile", 5, 1)];
    const out = budget({
      items,
      maxTokens: 100,
      split: { activeFile: 0, dependencies: 0, summaries: 0, history: 0 },
    });
    // Even distribution gives activeFile 25 tokens → a 5-token item is included.
    expect(out.decisions[0].included).toBe(true);
  });

  test("zero-token items are always included regardless of remaining budget", () => {
    const items: ContextItem[] = [
      item("big", "activeFile", 1000, 0.5),
      item("free", "dependencies", 0, 0.5),
    ];
    const out = budget({
      items,
      maxTokens: 20,
      split: { activeFile: 0.5, dependencies: 0.5, summaries: 0, history: 0 },
    });
    const free = out.decisions.find((d) => d.item.id === "free")!;
    expect(free.included).toBe(true);
  });

  test("empty items list returns empty decisions without throwing", () => {
    const out = budget({
      items: [],
      maxTokens: 100,
      split: { activeFile: 0.5, dependencies: 0.5, summaries: 0, history: 0 },
    });
    expect(out.decisions).toEqual([]);
    expect(out.totalUsed).toBe(0);
  });

  test("single item that exactly fits its category quota is included", () => {
    const items: ContextItem[] = [item("exact", "summaries", 20, 0.5)];
    const out = budget({
      items,
      maxTokens: 100,
      split: { activeFile: 0, dependencies: 0, summaries: 0.2, history: 0.8 },
    });
    // summaries quota = floor(100 * 0.2) = 20
    const exact = out.decisions[0];
    expect(exact.included).toBe(true);
    expect(out.totalUsed).toBe(20);
  });

  // --- usage reporting ------------------------------------------------------

  test("usage reports correct per-category token counts and item counts", () => {
    const items: ContextItem[] = [
      item("a", "activeFile", 30, 1),
      item("d", "dependencies", 20, 0.8),
    ];
    const out = budget({
      items,
      maxTokens: 100,
      split: { activeFile: 0.5, dependencies: 0.5, summaries: 0, history: 0 },
    });
    const activeUsage = out.usage.find((u) => u.category === "activeFile")!;
    const depUsage = out.usage.find((u) => u.category === "dependencies")!;

    expect(activeUsage.used).toBe(30);
    expect(activeUsage.items).toBe(1);
    expect(depUsage.used).toBe(20);
    expect(depUsage.items).toBe(1);
    expect(out.totalUsed).toBe(50);
  });

  test("usage always includes all four categories even when some are empty", () => {
    const out = budget({
      items: [],
      maxTokens: 100,
      split: { activeFile: 0.25, dependencies: 0.25, summaries: 0.25, history: 0.25 },
    });
    const categories = out.usage.map((u) => u.category).sort();
    expect(categories).toEqual(["activeFile", "dependencies", "history", "summaries"]);
  });

  test("totalUsed matches the sum of per-category used amounts", () => {
    const items: ContextItem[] = [
      item("a1", "activeFile", 10, 1),
      item("d1", "dependencies", 15, 0.8),
      item("s1", "summaries", 5, 0.5),
    ];
    const out = budget({
      items,
      maxTokens: 200,
      split: { activeFile: 0.4, dependencies: 0.4, summaries: 0.2, history: 0 },
    });
    const sumFromUsage = out.usage.reduce((s, u) => s + u.used, 0);
    expect(out.totalUsed).toBe(sumFromUsage);
  });
});
