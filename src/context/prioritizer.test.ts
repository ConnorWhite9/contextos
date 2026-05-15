import { describe, expect, test } from "vitest";
import { prioritize } from "./prioritizer";
import { ContextItem, IContextStateStore } from "../utils/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Typed state stub — satisfies IContextStateStore without `as any`.
 * The prioritizer only needs `recencyScore`; the other methods are no-ops.
 */
function makeStateStub(recencyFn?: (path: string) => number): IContextStateStore {
  return {
    get: () => ({ invariants: [], workingMemory: [], history: [] }),
    recencyScore: recencyFn ?? (() => 0),
    recordHistory: () => undefined,
  };
}

function item(
  path: string,
  score: number,
  category: ContextItem["category"] = "summaries",
): ContextItem {
  return {
    id: `${category}:${path}`,
    path,
    category,
    content: "x",
    tokens: 1,
    score,
    reasons: [],
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("context/prioritizer", () => {
  // --- active-file pinning ---------------------------------------------------

  test("pins active file score to 1.0 regardless of its base score", () => {
    const active = item("/a.ts", 0.2, "activeFile");
    const other = item("/b.ts", 0.9);
    const state = makeStateStub();

    const out = prioritize({ items: [other, active], activeFilePath: "/a.ts", state, taskKeywords: [] });

    const pinned = out.find((i) => i.path === "/a.ts")!;
    expect(pinned.score).toBe(1);
    expect(pinned.reasons.some((r) => r.code === "active")).toBe(true);
  });

  test("active file is ranked first even when another item has a higher base score", () => {
    const active = item("/a.ts", 0.0, "activeFile");
    const strong = item("/b.ts", 0.99);
    const state = makeStateStub();

    const out = prioritize({ items: [strong, active], activeFilePath: "/a.ts", state, taskKeywords: [] });
    expect(out[0].path).toBe("/a.ts");
  });

  test("activeFilePath that matches no item leaves all items unaffected", () => {
    const state = makeStateStub();
    const a = item("/a.ts", 0.7);
    const out = prioritize({ items: [a], activeFilePath: "/missing.ts", state, taskKeywords: [] });
    // score should be composite, not 1
    expect(out[0].score).toBeLessThan(1);
  });

  // --- tiebreaking ----------------------------------------------------------

  test("is deterministic on ties: lexicographic path tiebreak", () => {
    const state = makeStateStub();
    const a = item("/a.ts", 0.5);
    const b = item("/b.ts", 0.5);
    const out = prioritize({ items: [b, a], state, taskKeywords: [] });
    expect(out.map((i) => i.path)).toEqual(["/a.ts", "/b.ts"]);
  });

  test("tiebreak is stable regardless of input order", () => {
    const state = makeStateStub();
    const a = item("/a.ts", 0.5);
    const b = item("/b.ts", 0.5);
    const out1 = prioritize({ items: [a, b], state, taskKeywords: [] });
    const out2 = prioritize({ items: [b, a], state, taskKeywords: [] });
    expect(out1.map((i) => i.path)).toEqual(out2.map((i) => i.path));
  });

  // --- keyword signal -------------------------------------------------------

  test("keyword match in file path boosts score above an equal-base item", () => {
    const state = makeStateStub();
    const withKeyword = item("/src/userService.ts", 0.5);
    const withoutKeyword = item("/src/other.ts", 0.5);

    const out = prioritize({ items: [withoutKeyword, withKeyword], state, taskKeywords: ["user"] });

    const kwIdx = out.findIndex((i) => i.path === "/src/userService.ts");
    const noKwIdx = out.findIndex((i) => i.path === "/src/other.ts");
    expect(kwIdx).toBeLessThan(noKwIdx);
  });

  test("keyword match adds a keyword-match reason to the item", () => {
    const state = makeStateStub();
    const a = item("/src/fetchUser.ts", 0.5);
    const out = prioritize({ items: [a], state, taskKeywords: ["fetchUser"] });
    expect(out[0].reasons.some((r) => r.code === "keyword-match")).toBe(true);
  });

  test("no keyword match means no keyword-match reason", () => {
    const state = makeStateStub();
    const a = item("/src/other.ts", 0.5);
    const out = prioritize({ items: [a], state, taskKeywords: ["user"] });
    expect(out[0].reasons.some((r) => r.code === "keyword-match")).toBe(false);
  });

  test("partial keyword match (2 of 3 keywords) gives score between 0 and 1 exclusive", () => {
    const state = makeStateStub();
    // Path contains "user" and "service" but not "fetch"
    const a = item("/src/userService.ts", 0.5);
    const outFull = prioritize({ items: [a], state, taskKeywords: ["user"] });
    const outPartial = prioritize({ items: [a], state, taskKeywords: ["user", "service", "fetch"] });
    // Partial match should still be positive but less than full match
    expect(outPartial[0].score).toBeGreaterThan(0);
    expect(outPartial[0].score).toBeLessThanOrEqual(outFull[0].score);
  });

  // --- recency signal -------------------------------------------------------

  test("recency signal shifts ordering: recently-seen file ranked above cold equal-base file", () => {
    const recent = item("/recent.ts", 0.5);
    const cold = item("/cold.ts", 0.5);
    const state = makeStateStub((p) => (p === "/recent.ts" ? 1 : 0));

    const out = prioritize({ items: [cold, recent], state, taskKeywords: [] });
    const recentIdx = out.findIndex((i) => i.path === "/recent.ts");
    const coldIdx = out.findIndex((i) => i.path === "/cold.ts");
    expect(recentIdx).toBeLessThan(coldIdx);
  });

  test("recency > 0 adds a recent-edit reason", () => {
    const state = makeStateStub((p) => (p === "/x.ts" ? 0.8 : 0));
    const a = item("/x.ts", 0.5);
    const out = prioritize({ items: [a], state, taskKeywords: [] });
    expect(out[0].reasons.some((r) => r.code === "recent-edit")).toBe(true);
  });

  test("recency = 0 does NOT add a recent-edit reason", () => {
    const state = makeStateStub(() => 0);
    const a = item("/x.ts", 0.5);
    const out = prioritize({ items: [a], state, taskKeywords: [] });
    expect(out[0].reasons.some((r) => r.code === "recent-edit")).toBe(false);
  });

  // --- score bounds ---------------------------------------------------------

  test("composite score is always clamped to [0, 1]", () => {
    const state = makeStateStub(() => 1);
    const a = item("/x.ts", 1.0);
    const out = prioritize({ items: [a], state, taskKeywords: ["x"] });
    expect(out[0].score).toBeLessThanOrEqual(1);
    expect(out[0].score).toBeGreaterThanOrEqual(0);
  });

  test("empty item list returns empty array without throwing", () => {
    const state = makeStateStub();
    const out = prioritize({ items: [], state, taskKeywords: ["anything"] });
    expect(out).toEqual([]);
  });
});
