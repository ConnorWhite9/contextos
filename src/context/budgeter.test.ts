import { describe, expect, test } from "vitest";
import { budget } from "./budgeter";
import { ContextItem } from "../utils/types";

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

describe("budgeter", () => {
  test("respects category quotas then spills over unused headroom", () => {
    const items: ContextItem[] = [
      // activeFile quota should include the top item
      item("a1", "activeFile", 30, 0.9),
      // deps quota only allows one, second should be picked up in spillover
      item("d1", "dependencies", 25, 0.8),
      item("d2", "dependencies", 25, 0.7),
      // summaries quota is 0 in this split
      item("s1", "summaries", 10, 0.6),
    ];

    const out = budget({
      items,
      maxTokens: 100,
      split: {
        activeFile: 0.3, // 30
        dependencies: 0.25, // 25
        summaries: 0,
        history: 0.45, // 45 (unused, spills)
      },
    });

    const included = out.decisions.filter((d) => d.included).map((d) => d.item.id);
    expect(included).toContain("a1");
    expect(included).toContain("d1");
    // spillover should include d2 (headroom exists from history)
    expect(included).toContain("d2");
    // summaries quota is 0, but spillover can still include if headroom allows
    expect(included).toContain("s1");

    expect(out.totalUsed).toBe(30 + 25 + 25 + 10);
  });

  test("excludes items when global budget exhausted", () => {
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
});

