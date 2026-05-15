import * as fs from "fs";
import * as path from "path";
import { ContextState, HistoryEntry, IContextStateStore } from "../utils/types";

/**
 * File-backed state store for the CLI.
 *
 * Persists to `<workspaceRoot>/.contextos/state.json` so the recency signal
 * and invariants accumulate across CLI invocations, the same way the VS Code
 * extension accumulates them across sessions. The file is gitignored by
 * convention (add `.contextos/` to your .gitignore).
 *
 * Persistence failures are swallowed — the CLI's primary job is to emit a
 * prompt, not to maintain state.
 */

const MAX_HISTORY = 50;

export class FileStateStore implements IContextStateStore {
  private cache: ContextState;
  private readonly statePath: string;

  constructor(workspaceRoot: string) {
    this.statePath = path.join(workspaceRoot, ".contextos", "state.json");
    this.cache = this.load();
  }

  get(): ContextState {
    return {
      invariants: [...this.cache.invariants],
      workingMemory: [...this.cache.workingMemory],
      history: [...this.cache.history],
    };
  }

  recencyScore(filePath: string): number {
    if (this.cache.history.length === 0) {
      return 0;
    }
    let score = 0;
    for (let i = 0; i < this.cache.history.length; i++) {
      const entry = this.cache.history[i];
      if (!entry.includedPaths.includes(filePath)) {
        continue;
      }
      const age = this.cache.history.length - i;
      score += 1 / age;
    }
    return Math.min(score, 1);
  }

  recordHistory(entry: HistoryEntry): void {
    this.cache.history.push(entry);
    if (this.cache.history.length > MAX_HISTORY) {
      this.cache.history.splice(0, this.cache.history.length - MAX_HISTORY);
    }
    this.persist();
  }

  private load(): ContextState {
    try {
      const raw = JSON.parse(fs.readFileSync(this.statePath, "utf8")) as ContextState;
      return {
        invariants: raw.invariants ?? [],
        workingMemory: raw.workingMemory ?? [],
        history: raw.history ?? [],
      };
    } catch {
      return { invariants: [], workingMemory: [], history: [] };
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.statePath), { recursive: true });
      fs.writeFileSync(this.statePath, JSON.stringify(this.cache, null, 2), "utf8");
    } catch {
      // Non-fatal: state persistence is best-effort in CLI mode.
    }
  }
}
