import { describe, expect, test } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { FileStateStore } from "./fileState";
import { HistoryEntry } from "../utils/types";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "contextos-state-"));
}

function makeEntry(task: string, paths: string[] = []): HistoryEntry {
  return {
    timestamp: Date.now(),
    task,
    promptTokens: 100,
    includedPaths: paths,
  };
}

describe("cli/fileState", () => {
  // --- initial state --------------------------------------------------------

  test("starts with empty invariants, workingMemory, and history", () => {
    const store = new FileStateStore(tmpWorkspace());
    const state = store.get();
    expect(state.invariants).toEqual([]);
    expect(state.workingMemory).toEqual([]);
    expect(state.history).toEqual([]);
  });

  test("get() returns a defensive copy (mutation does not affect internal state)", () => {
    const store = new FileStateStore(tmpWorkspace());
    const s1 = store.get();
    s1.invariants.push("mutated externally");
    const s2 = store.get();
    expect(s2.invariants).toEqual([]);
  });

  // --- recencyScore: empty history -----------------------------------------

  test("recencyScore returns 0 when history is empty", () => {
    const store = new FileStateStore(tmpWorkspace());
    expect(store.recencyScore("/any/path.ts")).toBe(0);
  });

  // --- recencyScore: with history ------------------------------------------

  test("recencyScore returns 0 for a path not in history", () => {
    const store = new FileStateStore(tmpWorkspace());
    store.recordHistory(makeEntry("task", ["/a.ts"]));
    expect(store.recencyScore("/b.ts")).toBe(0);
  });

  test("recencyScore is positive for a path that appears in history", () => {
    const store = new FileStateStore(tmpWorkspace());
    store.recordHistory(makeEntry("task", ["/a.ts"]));
    expect(store.recencyScore("/a.ts")).toBeGreaterThan(0);
  });

  test("recencyScore is capped at 1.0 regardless of how often a path appears", () => {
    const store = new FileStateStore(tmpWorkspace());
    for (let i = 0; i < 60; i++) {
      store.recordHistory(makeEntry(`task-${i}`, ["/hot.ts"]));
    }
    expect(store.recencyScore("/hot.ts")).toBeLessThanOrEqual(1);
  });

  test("more recently seen path scores higher than an older path", () => {
    const store = new FileStateStore(tmpWorkspace());
    // old appears first, then is forgotten; recent always appears
    store.recordHistory(makeEntry("t1", ["/old.ts"]));
    store.recordHistory(makeEntry("t2", ["/recent.ts"]));
    store.recordHistory(makeEntry("t3", ["/recent.ts"]));

    expect(store.recencyScore("/recent.ts")).toBeGreaterThan(store.recencyScore("/old.ts"));
  });

  // --- recordHistory: capped at MAX_HISTORY ---------------------------------

  test("history is capped at 50 entries (oldest evicted)", () => {
    const ws = tmpWorkspace();
    const store = new FileStateStore(ws);
    for (let i = 0; i < 55; i++) {
      store.recordHistory(makeEntry(`task-${i}`));
    }
    const state = store.get();
    expect(state.history.length).toBe(50);
    // The oldest entries should have been evicted; task-54 (most recent) survives
    expect(state.history.some((h) => h.task === "task-54")).toBe(true);
    expect(state.history.some((h) => h.task === "task-0")).toBe(false);
  });

  // --- persistence ----------------------------------------------------------

  test("state persists across instances (new instance reads saved state)", () => {
    const ws = tmpWorkspace();

    const storeA = new FileStateStore(ws);
    storeA.recordHistory(makeEntry("persisted-task", ["/a.ts", "/b.ts"]));

    // Create a new instance pointing at the same workspace
    const storeB = new FileStateStore(ws);
    const state = storeB.get();

    expect(state.history).toHaveLength(1);
    expect(state.history[0].task).toBe("persisted-task");
    expect(state.history[0].includedPaths).toContain("/a.ts");
  });

  test("state file is created under <workspace>/.contextos/state.json", () => {
    const ws = tmpWorkspace();
    const store = new FileStateStore(ws);
    store.recordHistory(makeEntry("check-path"));

    const expectedPath = path.join(ws, ".contextos", "state.json");
    expect(fs.existsSync(expectedPath)).toBe(true);
  });

  test("state file is valid JSON after a write", () => {
    const ws = tmpWorkspace();
    const store = new FileStateStore(ws);
    store.recordHistory(makeEntry("json-check"));

    const raw = fs.readFileSync(path.join(ws, ".contextos", "state.json"), "utf8");
    expect(() => JSON.parse(raw)).not.toThrow();
  });

  test("does not throw when the workspace does not have .contextos yet", () => {
    const ws = tmpWorkspace();
    // .contextos dir should NOT exist yet
    const stateDir = path.join(ws, ".contextos");
    expect(fs.existsSync(stateDir)).toBe(false);

    expect(() => {
      const store = new FileStateStore(ws);
      store.recordHistory(makeEntry("creates-dir"));
    }).not.toThrow();

    expect(fs.existsSync(stateDir)).toBe(true);
  });

  test("loads gracefully from a corrupt/missing state file (returns empty state)", () => {
    const ws = tmpWorkspace();
    const stateDir = path.join(ws, ".contextos");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, "state.json"), "not valid json", "utf8");

    const store = new FileStateStore(ws);
    const state = store.get();
    expect(state.invariants).toEqual([]);
    expect(state.history).toEqual([]);
  });

  // --- satisfies IContextStateStore -----------------------------------------

  test("implements the full IContextStateStore contract (structural check)", () => {
    const store = new FileStateStore(tmpWorkspace());
    // Calling each method once confirms they exist and return the correct shapes.
    const state = store.get();
    expect(typeof state.invariants).toBe("object");
    expect(typeof store.recencyScore("/x.ts")).toBe("number");
    expect(() => store.recordHistory(makeEntry("contract-check"))).not.toThrow();
  });
});
