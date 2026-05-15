/**
 * Shared domain types for ContextOS.
 *
 * These are intentionally framework-agnostic: nothing in this file imports
 * from `vscode`. That lets us unit-test the engine headlessly and keeps
 * boundaries clean between the VS Code host layer and the scheduler core.
 */

export type ContextCategory =
  | "activeFile"
  | "dependencies"
  | "summaries"
  | "history";

/** Why a given item was selected — surfaced in the preview panel. */
export interface SelectionReason {
  /** Short code, useful for testing and UI grouping. */
  code:
    | "active"
    | "direct-import"
    | "transitive-import"
    | "recent-edit"
    | "keyword-match"
    | "invariant"
    | "history";
  /** Human-readable explanation for the preview panel. */
  detail: string;
}

/**
 * A compressed view of a source file produced by the AST compressor.
 * Full source is *not* stored here — we only keep structural slices.
 */
export interface CompressedFile {
  path: string;
  /** Monotonic file mtime (ms since epoch); used as cache key. */
  mtimeMs: number;
  /**
   * Raw import specifiers (e.g. `"./user"`, `"react"`). Both relative and
   * bare imports are kept — they're cheap and tell the model what the
   * file depends on.
   */
  imports: string[];
  signatures: string[];
  types: string[];
  classes: string[];
  /** Exported symbol names (useful for summaries and keyword matching). */
  exports: string[];
  /** One-line natural-language summary of what the file does. */
  summary: string;
  /** Byte length of the original source, for reporting. */
  originalBytes: number;
  /** Size of the rendered compressed form in characters, for ratios. */
  compressedChars: number;
}

/**
 * A single unit of context considered by the scheduler.
 * The engine produces these, the prioritizer scores them, the budgeter
 * accepts or rejects them.
 */
export interface ContextItem {
  id: string;
  path: string;
  category: ContextCategory;
  /** Serialized text that will go into the prompt if included. */
  content: string;
  /** Approximate token count of `content`. */
  tokens: number;
  /** Computed score in [0, 1]; higher = more likely to survive the budget. */
  score: number;
  reasons: SelectionReason[];
  /** Optional underlying compressed form (for `summaries` items). */
  compressed?: CompressedFile;
}

/** Outcome for a candidate after the budgeter runs. */
export interface BudgetDecision {
  item: ContextItem;
  included: boolean;
  /** Reason for exclusion, if any (e.g. "category full", "global budget"). */
  excludedBecause?: string;
}

/** Per-category view of the final budget allocation. */
export interface CategoryUsage {
  category: ContextCategory;
  allocated: number;
  used: number;
  items: number;
}

/** The full result of a scheduling pass, consumed by UI + provider. */
export interface ScheduleResult {
  task: string;
  maxTokens: number;
  totalTokensUsed: number;
  categories: CategoryUsage[];
  decisions: BudgetDecision[];
  prompt: string;
  elapsedMs: number;
}

/** Persistent state held across invocations. */
export interface ContextState {
  /** Long-lived facts about the project (e.g. "uses pnpm", "strict TS"). */
  invariants: string[];
  /** Short-lived working notes carried between tasks. */
  workingMemory: string[];
  /** Chronological record of past tasks + their prompts. */
  history: HistoryEntry[];
}

export interface HistoryEntry {
  timestamp: number;
  task: string;
  /** Tokens in the prompt sent (not the response). */
  promptTokens: number;
  /** Paths included, for retrieval-by-recency. */
  includedPaths: string[];
}

/**
 * Minimal state interface consumed by the engine pipeline.
 *
 * Both the VS Code implementation (vscode.Memento-backed) and the CLI
 * implementation (JSON-file-backed) satisfy this contract, so all core
 * modules can stay vscode-free while still being driven by either host.
 */
export interface IContextStateStore {
  get(): ContextState;
  recencyScore(path: string): number;
  recordHistory(entry: HistoryEntry): void;
}

/** Input to the engine — a single user request. */
export interface EngineRequest {
  task: string;
  activeFilePath?: string;
  activeFileContent?: string;
  /** Recently edited paths, most-recent first. */
  recentlyEditedPaths: string[];
  /** All candidate workspace paths (already capped upstream). */
  workspacePaths: string[];
  /** Max transitive import depth to consider when collecting dependencies. */
  maxDependencyDepth: number;
  /** Max tokens to spend on the assembled prompt. */
  maxTokens: number;
  /** Proportional split, must sum to ~1.0. */
  budgetSplit: Record<ContextCategory, number>;
}
