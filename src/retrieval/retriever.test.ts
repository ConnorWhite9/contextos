import { describe, expect, test } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { importGraphWithResolver, keywordHits, keywordsFromTask } from "./retriever";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contextos-"));
}

describe("retrieval/retriever", () => {
  test("importGraphWithResolver finds direct and transitive imports with depth decay", () => {
    const dir = tmpDir();
    const a = path.join(dir, "a.ts");
    const b = path.join(dir, "b.ts");
    const c = path.join(dir, "c.ts");

    fs.writeFileSync(a, "import { b } from './b';\nexport const a = 1;\n", "utf8");
    fs.writeFileSync(b, "export { c } from './c';\nexport const b = 2;\n", "utf8");
    fs.writeFileSync(c, "export const c = 3;\n", "utf8");

    const exists = (p: string) => fs.existsSync(p);
    const hits = importGraphWithResolver(a, 3, exists);

    const hb = hits.find((h) => h.path === b)!;
    const hc = hits.find((h) => h.path === c)!;

    expect(hb.reason).toBe("direct-import");
    expect(hb.depth).toBe(1);
    expect(hb.score).toBeCloseTo(1, 5);

    expect(hc.reason).toBe("transitive-import");
    expect(hc.depth).toBe(2);
    expect(hc.score).toBeCloseTo(0.5, 5);
  });

  test("keywordsFromTask strips stopwords and short tokens", () => {
    const k = keywordsFromTask("please fix the user service and add tests");
    expect(k).toContain("user");
    expect(k).toContain("service");
    expect(k).not.toContain("the");
  });

  test("keywordHits scores by header matches only", () => {
    const dir = tmpDir();
    const f1 = path.join(dir, "userService.ts");
    const f2 = path.join(dir, "other.ts");
    fs.writeFileSync(f1, "export function fetchUser() {}\n", "utf8");
    fs.writeFileSync(f2, "export function somethingElse() {}\n", "utf8");

    const hits = keywordHits([f1, f2], ["fetchUser", "user"], 40);
    expect(hits.find((h) => h.path === f1)).toBeTruthy();
    expect(hits.find((h) => h.path === f2)).toBeFalsy();
  });
});

