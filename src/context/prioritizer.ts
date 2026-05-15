import { ContextItem, IContextStateStore, SelectionReason } from "../utils/types";
import { fileKindWeight } from "../utils/paths";

/**
 * Prioritization.
 *
 * Scoring is intentionally explainable — each contributor appears in the
 * final reason list so the preview panel can show *why* a file is in (or
 * out of) the prompt. This is what makes ContextOS debuggable vs. a black
 * box prompt builder.
 *
 * Final score is clamped to [0, 1]. Signals:
 *   - base: the raw signal from the retrieval layer (import depth or keyword).
 *   - kind: file-type weight (tests score lower, `.d.ts` medium, src full).
 *   - recency: fraction of recent history that included this path.
 *   - activeBoost: the active file itself always pins to 1.0.
 */

export interface PrioritizerInputs {
  /** Items from the engine, already tagged with category and base reasons. */
  items: ContextItem[];
  /** Absolute path of the active file, if any. */
  activeFilePath?: string;
  /** State store used for recency weighting. */
  state: IContextStateStore;
  /** Keywords derived from the task — boosts items whose path contains them. */
  taskKeywords: string[];
}

export function prioritize(inputs: PrioritizerInputs): ContextItem[] {
  const { items, activeFilePath, state, taskKeywords } = inputs;
  const lowerKeywords = taskKeywords.map((k) => k.toLowerCase());

  for (const item of items) {
    if (activeFilePath && item.path === activeFilePath) {
      item.score = 1;
      item.reasons.push({
        code: "active",
        detail: "This is the currently active file.",
      });
      continue;
    }

    const base = item.score; // whatever the retriever already assigned
    const kind = fileKindWeight(item.path);
    const recency = state.recencyScore(item.path);
    const pathHit = matchesKeywordsInPath(item.path, lowerKeywords);

    // Weighted sum, tuned so each signal can meaningfully move the ranking
    // without any single one dominating. These weights are the first knobs
    // to tune with real telemetry.
    const composite =
      0.55 * base + 0.2 * kind + 0.15 * recency + 0.1 * pathHit;

    item.score = clamp01(composite);

    if (recency > 0) {
      item.reasons.push({
        code: "recent-edit",
        detail: `Appeared in ${Math.round(recency * 100)}% of recent tasks.`,
      });
    }
    if (pathHit > 0) {
      item.reasons.push({
        code: "keyword-match",
        detail: "File path matches a keyword from the task.",
      });
    }
  }

  return items.sort(byScoreDesc);
}

function matchesKeywordsInPath(path: string, lowerKeywords: string[]): number {
  if (lowerKeywords.length === 0) {
    return 0;
  }
  const lower = path.toLowerCase();
  let count = 0;
  for (const k of lowerKeywords) {
    if (lower.includes(k)) {
      count += 1;
    }
  }
  return count / lowerKeywords.length;
}

function clamp01(x: number): number {
  if (x < 0) return 0;
  if (x > 1) return 1;
  return x;
}

function byScoreDesc(a: ContextItem, b: ContextItem): number {
  if (a.score !== b.score) {
    return b.score - a.score;
  }
  // Deterministic tiebreak so results are reproducible in tests.
  return a.path.localeCompare(b.path);
}

/** Convenience helper for building a base reason when tagging items. */
export function reason(
  code: SelectionReason["code"],
  detail: string,
): SelectionReason {
  return { code, detail };
}
