import {
  BudgetDecision,
  CategoryUsage,
  ContextCategory,
  ContextItem,
} from "../utils/types";

/**
 * Token budget controller.
 *
 * Given a global cap `maxTokens` and a proportional split across
 * categories, greedily include highest-priority items per-category until
 * each category's quota is exhausted. Any *unused* quota spills into a
 * shared pool so a sparse category (say, no dependencies) doesn't waste
 * budget.
 *
 * Emits a structured decision per item — included or excluded with a
 * reason — which the preview panel renders verbatim.
 */

export interface BudgetInputs {
  items: ContextItem[]; // assumed sorted by score desc
  maxTokens: number;
  split: Record<ContextCategory, number>;
}

export interface BudgetOutputs {
  decisions: BudgetDecision[];
  usage: CategoryUsage[];
  totalUsed: number;
}

const CATEGORIES: ContextCategory[] = [
  "activeFile",
  "dependencies",
  "summaries",
  "history",
];

export function budget(inputs: BudgetInputs): BudgetOutputs {
  const { items, maxTokens, split } = inputs;

  const normalized = normalizeSplit(split);
  const allocated: Record<ContextCategory, number> = {
    activeFile: Math.floor(maxTokens * normalized.activeFile),
    dependencies: Math.floor(maxTokens * normalized.dependencies),
    summaries: Math.floor(maxTokens * normalized.summaries),
    history: Math.floor(maxTokens * normalized.history),
  };
  const used: Record<ContextCategory, number> = {
    activeFile: 0,
    dependencies: 0,
    summaries: 0,
    history: 0,
  };
  const counts: Record<ContextCategory, number> = {
    activeFile: 0,
    dependencies: 0,
    summaries: 0,
    history: 0,
  };

  // First pass: honour per-category quotas in priority order.
  const decisions: BudgetDecision[] = [];
  const leftover: ContextItem[] = [];

  for (const item of items) {
    const cat = item.category;
    if (used[cat] + item.tokens <= allocated[cat]) {
      used[cat] += item.tokens;
      counts[cat] += 1;
      decisions.push({ item, included: true });
    } else {
      leftover.push(item);
    }
  }

  // Second pass: spillover — any category under its quota has headroom
  // that can be spent on globally high-priority leftovers.
  const totalAllocated = CATEGORIES.reduce((sum, c) => sum + allocated[c], 0);
  const totalUsed = CATEGORIES.reduce((sum, c) => sum + used[c], 0);
  let headroom = maxTokens - totalUsed;
  // Safety: never exceed the global cap even if allocations rounded up.
  void totalAllocated;

  for (const item of leftover) {
    if (item.tokens <= headroom) {
      used[item.category] += item.tokens;
      counts[item.category] += 1;
      headroom -= item.tokens;
      decisions.push({
        item,
        included: true,
      });
    } else {
      decisions.push({
        item,
        included: false,
        excludedBecause:
          item.tokens > allocated[item.category]
            ? `Too large for ${item.category} quota (${item.tokens} tok)`
            : "Global token budget exhausted",
      });
    }
  }

  // Preserve input order for decisions — callers can re-sort if they want.
  decisions.sort(byInputOrder(items));

  const usage: CategoryUsage[] = CATEGORIES.map((c) => ({
    category: c,
    allocated: allocated[c],
    used: used[c],
    items: counts[c],
  }));

  return {
    decisions,
    usage,
    totalUsed: CATEGORIES.reduce((sum, c) => sum + used[c], 0),
  };
}

/**
 * Normalize a possibly-incomplete split so category proportions sum to 1.
 * Missing categories get 0; negative values are treated as 0. If the split
 * totals to 0 (pathological config), fall back to even distribution.
 */
function normalizeSplit(
  split: Record<ContextCategory, number>,
): Record<ContextCategory, number> {
  const sanitized: Record<ContextCategory, number> = {
    activeFile: Math.max(0, split.activeFile ?? 0),
    dependencies: Math.max(0, split.dependencies ?? 0),
    summaries: Math.max(0, split.summaries ?? 0),
    history: Math.max(0, split.history ?? 0),
  };
  const total =
    sanitized.activeFile +
    sanitized.dependencies +
    sanitized.summaries +
    sanitized.history;
  if (total <= 0) {
    return { activeFile: 0.25, dependencies: 0.25, summaries: 0.25, history: 0.25 };
  }
  return {
    activeFile: sanitized.activeFile / total,
    dependencies: sanitized.dependencies / total,
    summaries: sanitized.summaries / total,
    history: sanitized.history / total,
  };
}

function byInputOrder(
  originalOrder: ContextItem[],
): (a: BudgetDecision, b: BudgetDecision) => number {
  const index = new Map<string, number>();
  originalOrder.forEach((item, i) => index.set(item.id, i));
  return (a, b) =>
    (index.get(a.item.id) ?? 0) - (index.get(b.item.id) ?? 0);
}
