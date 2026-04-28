import { describe, expect, test } from "vitest";
import { prioritize } from "./prioritizer";
import { ContextItem } from "../utils/types";

function item(path: string, score: number): ContextItem {
  return {
    id: `summaries:${path}`,
    path,
    category: "summaries",
    content: "x",
    tokens: 1,
    score,
    reasons: [],
  };
}

describe("context/prioritizer", () => {
  test("pins active file score to 1.0 and adds an active reason", () => {
    const active = item("/a.ts", 0.2);
    active.category = "activeFile";
    const other = item("/b.ts", 0.9);

    const state = {
      recencyScore: () => 0,
    } as any;

    const out = prioritize({
      items: [other, active],
      activeFilePath: "/a.ts",
      state,
      taskKeywords: [],
    });

    const pinned = out.find((i) => i.path === "/a.ts")!;
    expect(pinned.score).toBe(1);
    expect(pinned.reasons.some((r: any) => r.code === "active")).toBe(true);
  });

  test("is deterministic on ties (path tiebreak)", () => {
    const state = { recencyScore: () => 0 } as any;
    const a = item("/a.ts", 0.5);
    const b = item("/b.ts", 0.5);
    const out = prioritize({
      items: [b, a],
      state,
      taskKeywords: [],
    });
    expect(out.map((i) => i.path)).toEqual(["/a.ts", "/b.ts"]);
  });
});

