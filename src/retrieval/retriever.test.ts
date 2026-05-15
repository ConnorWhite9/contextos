import { describe, expect, test } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { importGraphWithResolver, keywordHits, keywordsFromTask } from "./retriever";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contextos-retriever-"));
}

describe("retrieval/retriever", () => {
  // --- import graph ---------------------------------------------------------

  test("finds direct and transitive imports with correct depth-decay scores", () => {
    const dir = tmpDir();
    const a = path.join(dir, "a.ts");
    const b = path.join(dir, "b.ts");
    const c = path.join(dir, "c.ts");

    fs.writeFileSync(a, "import { b } from './b';\nexport const a = 1;\n", "utf8");
    fs.writeFileSync(b, "export { c } from './c';\nexport const b = 2;\n", "utf8");
    fs.writeFileSync(c, "export const c = 3;\n", "utf8");

    const hits = importGraphWithResolver(a, 3, (p) => fs.existsSync(p));

    const hb = hits.find((h) => h.path === b)!;
    const hc = hits.find((h) => h.path === c)!;

    expect(hb).toBeDefined();
    expect(hb.reason).toBe("direct-import");
    expect(hb.depth).toBe(1);
    expect(hb.score).toBeCloseTo(1, 5);

    expect(hc).toBeDefined();
    expect(hc.reason).toBe("transitive-import");
    expect(hc.depth).toBe(2);
    expect(hc.score).toBeCloseTo(0.5, 5);
  });

  test("respects maxDepth: does not traverse beyond the limit", () => {
    const dir = tmpDir();
    const a = path.join(dir, "a.ts");
    const b = path.join(dir, "b.ts");
    const c = path.join(dir, "c.ts");

    fs.writeFileSync(a, "import './b';\n", "utf8");
    fs.writeFileSync(b, "import './c';\n", "utf8");
    fs.writeFileSync(c, "export const x = 1;\n", "utf8");

    // maxDepth=1 means only direct imports; c should not appear
    const hits = importGraphWithResolver(a, 1, (p) => fs.existsSync(p));
    const paths = hits.map((h) => h.path);

    expect(paths).toContain(b);
    expect(paths).not.toContain(c);
  });

  test("maxDepth=0 returns no hits (entry file excluded from results)", () => {
    const dir = tmpDir();
    const a = path.join(dir, "a.ts");
    const b = path.join(dir, "b.ts");
    fs.writeFileSync(a, "import './b';\n", "utf8");
    fs.writeFileSync(b, "export const x = 1;\n", "utf8");

    const hits = importGraphWithResolver(a, 0, (p) => fs.existsSync(p));
    expect(hits).toHaveLength(0);
  });

  test("circular imports do not cause an infinite loop", () => {
    const dir = tmpDir();
    const a = path.join(dir, "a.ts");
    const b = path.join(dir, "b.ts");

    // a → b → a (cycle)
    fs.writeFileSync(a, "import './b';\nexport const a = 1;\n", "utf8");
    fs.writeFileSync(b, "import './a';\nexport const b = 2;\n", "utf8");

    // Should complete in finite time without stack overflow or infinite loop
    const hits = importGraphWithResolver(a, 5, (p) => fs.existsSync(p));
    // Each file should appear at most once in the hits
    const paths = hits.map((h) => h.path);
    const unique = new Set(paths);
    expect(unique.size).toBe(paths.length);
  });

  test("bare module specifiers are ignored (only relative paths resolved)", () => {
    const dir = tmpDir();
    const a = path.join(dir, "a.ts");
    fs.writeFileSync(a, "import React from 'react';\nimport './b';\n", "utf8");
    // b does not exist
    const hits = importGraphWithResolver(a, 2, () => false);
    // react should not appear; b doesn't exist so it's skipped too
    expect(hits.every((h) => !h.path.includes("react"))).toBe(true);
  });

  test("non-existent file returns empty hits without throwing", () => {
    const hits = importGraphWithResolver("/does/not/exist.ts", 2, () => false);
    expect(hits).toEqual([]);
  });

  test("depth score follows 1 / 2^(depth-1) pattern", () => {
    const dir = tmpDir();
    const a = path.join(dir, "a.ts");
    const b = path.join(dir, "b.ts");
    const c = path.join(dir, "c.ts");
    const d = path.join(dir, "d.ts");

    fs.writeFileSync(a, "import './b';\n", "utf8");
    fs.writeFileSync(b, "import './c';\n", "utf8");
    fs.writeFileSync(c, "import './d';\n", "utf8");
    fs.writeFileSync(d, "export const x = 1;\n", "utf8");

    const hits = importGraphWithResolver(a, 4, (p) => fs.existsSync(p));
    const hb = hits.find((h) => h.path === b)!;
    const hc = hits.find((h) => h.path === c)!;
    const hd = hits.find((h) => h.path === d)!;

    expect(hb.score).toBeCloseTo(1.0, 5);   // 1/2^0
    expect(hc.score).toBeCloseTo(0.5, 5);   // 1/2^1
    expect(hd.score).toBeCloseTo(0.25, 5);  // 1/2^2
  });

  // --- keywordsFromTask -----------------------------------------------------

  test("strips common stopwords from the task", () => {
    const k = keywordsFromTask("please fix the user service and add tests");
    expect(k).toContain("user");
    expect(k).toContain("service");
    expect(k).toContain("tests");
    expect(k).not.toContain("the");
    expect(k).not.toContain("and");
    expect(k).not.toContain("please");
    expect(k).not.toContain("fix");
    expect(k).not.toContain("add");
  });

  test("drops tokens shorter than 3 characters", () => {
    const k = keywordsFromTask("go to db");
    expect(k).not.toContain("go");
    expect(k).not.toContain("to");
    expect(k).not.toContain("db");
  });

  test("deduplicates case-insensitively while preserving first occurrence casing", () => {
    const k = keywordsFromTask("fetchUser fetchuser FETCHUSER");
    expect(k).toHaveLength(1);
    expect(k[0]).toBe("fetchUser");
  });

  test("returns empty array for an all-stopword task", () => {
    const k = keywordsFromTask("please fix and add the code");
    expect(k).toEqual([]);
  });

  // --- keywordHits ----------------------------------------------------------

  test("returns empty array when keywords list is empty", () => {
    const dir = tmpDir();
    const f = path.join(dir, "a.ts");
    fs.writeFileSync(f, "export const x = 1;\n", "utf8");

    const hits = keywordHits([f], []);
    expect(hits).toEqual([]);
  });

  test("matches file whose header contains a keyword", () => {
    const dir = tmpDir();
    const f1 = path.join(dir, "userService.ts");
    const f2 = path.join(dir, "other.ts");
    fs.writeFileSync(f1, "export function fetchUser() {}\n", "utf8");
    fs.writeFileSync(f2, "export function somethingElse() {}\n", "utf8");

    const hits = keywordHits([f1, f2], ["fetchUser", "user"], 40);
    expect(hits.find((h) => h.path === f1)).toBeTruthy();
    expect(hits.find((h) => h.path === f2)).toBeFalsy();
  });

  test("score equals matched-keywords / total-keywords (normalized)", () => {
    const dir = tmpDir();
    const f = path.join(dir, "service.ts");
    // Contains "user" but not "fetch"
    fs.writeFileSync(f, "export class UserService {}\n", "utf8");

    const hits = keywordHits([f], ["user", "fetch"]);
    const hit = hits.find((h) => h.path === f)!;
    expect(hit).toBeDefined();
    // 1 of 2 keywords matched → score = 0.5
    expect(hit.score).toBeCloseTo(0.5, 5);
  });

  test("all keywords matched produces score = 1.0", () => {
    const dir = tmpDir();
    const f = path.join(dir, "userFetch.ts");
    fs.writeFileSync(f, "export function fetchUser() {}\n", "utf8");

    const hits = keywordHits([f], ["fetch", "user"]);
    const hit = hits.find((h) => h.path === f)!;
    expect(hit).toBeDefined();
    expect(hit.score).toBeCloseTo(1.0, 5);
  });

  test("all hits carry reason=keyword-match and depth=0", () => {
    const dir = tmpDir();
    const f = path.join(dir, "userSvc.ts");
    fs.writeFileSync(f, "export function user() {}\n", "utf8");

    const hits = keywordHits([f], ["user"]);
    expect(hits[0].reason).toBe("keyword-match");
    expect(hits[0].depth).toBe(0);
  });

  test("non-TS files are silently skipped", () => {
    const dir = tmpDir();
    const jsonFile = path.join(dir, "data.json");
    fs.writeFileSync(jsonFile, '{"user": 1}', "utf8");

    const hits = keywordHits([jsonFile], ["user"]);
    expect(hits).toEqual([]);
  });

  test("returns empty array when candidates list is empty", () => {
    const hits = keywordHits([], ["user"]);
    expect(hits).toEqual([]);
  });
});
