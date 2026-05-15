import * as vscode from "vscode";
import { ContextState, HistoryEntry, IContextStateStore } from "../utils/types";

/**
 * Persistent scheduler state.
 *
 * We store three slices:
 *   - invariants:    user-declared facts that should survive across tasks
 *                    (e.g. "this project uses pnpm", "no `any`").
 *   - workingMemory: short-lived notes carried between tasks in a session.
 *   - history:       a trailing log of past tasks (paths + token counts),
 *                    used by the prioritizer as a recency/frequency signal.
 *
 * Persistence is done via `ExtensionContext.workspaceState` so each
 * workspace gets its own state without us writing files to disk. That
 * keeps the extension genuinely local-first — nothing leaves the machine,
 * and nothing is dropped in the user's repo either.
 */

const STATE_KEY = "contextos.state.v1";
const MAX_HISTORY = 50;
const MAX_WORKING_MEMORY = 20;

export class ContextStateStore implements IContextStateStore {
  private cache: ContextState;

  constructor(private readonly memento: vscode.Memento) {
    this.cache = this.load();
  }

  get(): ContextState {
    // Return a defensive shallow copy so callers don't mutate our cache.
    return {
      invariants: [...this.cache.invariants],
      workingMemory: [...this.cache.workingMemory],
      history: [...this.cache.history],
    };
  }

  addInvariant(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }
    if (!this.cache.invariants.includes(trimmed)) {
      this.cache.invariants.push(trimmed);
      void this.persist();
    }
  }

  removeInvariant(text: string): void {
    this.cache.invariants = this.cache.invariants.filter((i) => i !== text);
    void this.persist();
  }

  pushWorkingMemory(note: string): void {
    const trimmed = note.trim();
    if (!trimmed) {
      return;
    }
    this.cache.workingMemory.push(trimmed);
    if (this.cache.workingMemory.length > MAX_WORKING_MEMORY) {
      this.cache.workingMemory.splice(
        0,
        this.cache.workingMemory.length - MAX_WORKING_MEMORY,
      );
    }
    void this.persist();
  }

  clearWorkingMemory(): void {
    this.cache.workingMemory = [];
    void this.persist();
  }

  recordHistory(entry: HistoryEntry): void {
    this.cache.history.push(entry);
    if (this.cache.history.length > MAX_HISTORY) {
      this.cache.history.splice(0, this.cache.history.length - MAX_HISTORY);
    }
    void this.persist();
  }

  /**
   * How often a given path has appeared in recent history — used by the
   * prioritizer as a frequency signal. O(n) where n <= MAX_HISTORY, which
   * is bounded small enough that we don't need an index.
   */
  recencyScore(path: string): number {
    if (this.cache.history.length === 0) {
      return 0;
    }
    let score = 0;
    for (let i = 0; i < this.cache.history.length; i++) {
      const entry = this.cache.history[i];
      if (!entry.includedPaths.includes(path)) {
        continue;
      }
      // Newer entries weigh more. Linear decay is good enough for MVP.
      const age = this.cache.history.length - i;
      score += 1 / age;
    }
    return Math.min(score, 1);
  }

  private load(): ContextState {
    const raw = this.memento.get<ContextState>(STATE_KEY);
    if (!raw) {
      return { invariants: [], workingMemory: [], history: [] };
    }
    return {
      invariants: raw.invariants ?? [],
      workingMemory: raw.workingMemory ?? [],
      history: raw.history ?? [],
    };
  }

  private async persist(): Promise<void> {
    await this.memento.update(STATE_KEY, this.cache);
  }
}
