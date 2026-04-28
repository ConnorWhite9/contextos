import * as fs from "fs";
import {
  ContextItem,
  EngineRequest,
  ScheduleResult,
} from "../utils/types";
import { compressFile, renderCompressed } from "../ast/compressor";
import {
  importGraphWithResolver,
  keywordHits,
  keywordsFromTask,
  RetrievalHit,
} from "../retrieval/retriever";
import { prioritize, reason } from "./prioritizer";
import { budget } from "./budgeter";
import { buildPrompt } from "../prompt/builder";
import { ContextStateStore } from "./state";
import { estimateTokens, clampToTokens } from "../utils/tokens";
import { isTypeScriptLike } from "../utils/paths";
import { log } from "../utils/logger";

/**
 * The ContextEngine is the scheduler proper. Responsibilities:
 *
 *   1. Collect candidate files (active, imports, recent, keyword).
 *   2. Compress everything via the AST layer.
 *   3. Build typed `ContextItem`s per category.
 *   4. Score via the prioritizer.
 *   5. Allocate via the budgeter.
 *   6. Assemble the final prompt.
 *
 * Every step is observable from the outside — the `ScheduleResult` carries
 * both the prompt and every decision, which is what powers the preview UI.
 *
 * Target: <150ms on a medium TS repo. We hit that with:
 *   - cached AST parsing (parser.ts)
 *   - capped workspace scan (maxFilesScanned from settings)
 *   - partial header reads for keyword scoring
 */

export class ContextEngine {
  constructor(private readonly state: ContextStateStore) {}

  async run(req: EngineRequest): Promise<ScheduleResult> {
    const start = Date.now();

    const candidates = this.collectCandidates(req);
    const items = this.buildItems(req, candidates);

    const taskKeywords = keywordsFromTask(req.task);
    prioritize({
      items,
      activeFilePath: req.activeFilePath,
      state: this.state,
      taskKeywords,
    });

    const { decisions, usage, totalUsed } = budget({
      items,
      maxTokens: req.maxTokens,
      split: req.budgetSplit,
    });

    const built = buildPrompt({
      task: req.task,
      decisions,
      state: this.state.get(),
    });

    const elapsedMs = Date.now() - start;
    log.info(
      `engine.run: ${items.length} items, ${totalUsed}/${req.maxTokens} tokens, ${elapsedMs}ms`,
    );

    return {
      task: req.task,
      maxTokens: req.maxTokens,
      totalTokensUsed: built.tokens,
      categories: usage,
      decisions,
      prompt: built.prompt,
      elapsedMs,
    };
  }

  /**
   * Walk the graph of candidate files from three sources — active file,
   * import graph, keyword retrieval — and union them into a single map
   * keyed by path. Each entry carries the retrieval signals that fed it in.
   */
  private collectCandidates(req: EngineRequest): Map<string, Candidate> {
    const out = new Map<string, Candidate>();

    const push = (path: string, hit: RetrievalHit | "active" | "recent"): void => {
      const existing = out.get(path);
      if (!existing) {
        out.set(path, { path, hits: [], fromActive: false, fromRecent: false });
      }
      const entry = out.get(path)!;
      if (hit === "active") {
        entry.fromActive = true;
      } else if (hit === "recent") {
        entry.fromRecent = true;
      } else {
        entry.hits.push(hit);
      }
    };

    if (req.activeFilePath) {
      push(req.activeFilePath, "active");

      // Import graph radiates outward from the active file. We only
      // accept hits that point at files we already saw in workspacePaths;
      // this prevents node_modules from leaking in.
      const wsSet = new Set(req.workspacePaths);
      const hits = importGraphWithResolver(
        req.activeFilePath,
        req.maxDependencyDepth,
        (p) => wsSet.has(p),
      );
      for (const h of hits) {
        if (wsSet.has(h.path)) {
          push(h.path, h);
        }
      }
    }

    for (const recent of req.recentlyEditedPaths.slice(0, 10)) {
      push(recent, "recent");
    }

    const keywords = keywordsFromTask(req.task);
    const keywordCandidates = keywordHits(
      req.workspacePaths.filter(isTypeScriptLike),
      keywords,
    );
    for (const h of keywordCandidates) {
      push(h.path, h);
    }

    return out;
  }

  /**
   * Turn raw candidates into `ContextItem`s with category, content, tokens,
   * and a preliminary score from the retrieval signals. The prioritizer
   * will refine the scores in-place afterwards.
   */
  private buildItems(
    req: EngineRequest,
    candidates: Map<string, Candidate>,
  ): ContextItem[] {
    const items: ContextItem[] = [];

    for (const [path, cand] of candidates) {
      // Categorize: active file stays whole, direct imports are "dependencies",
      // everything else gets summarized.
      let category: ContextItem["category"];
      if (cand.fromActive) {
        category = "activeFile";
      } else if (cand.hits.some((h) => h.reason === "direct-import")) {
        category = "dependencies";
      } else {
        category = "summaries";
      }

      const compressed = isTypeScriptLike(path) ? compressFile(path) : undefined;

      // Content strategy per category:
      //   - activeFile: full source (clamped to a soft cap to avoid one
      //     massive file blowing the whole budget).
      //   - dependencies: compressed rendering (signatures, types, classes).
      //   - summaries: the one-liner summary only.
      let content: string;
      if (category === "activeFile") {
        content = readFileSafe(path, req.activeFileContent);
        // Hard-cap at 60% of the global budget for any single file — a
        // guardrail against 5000-line generated files.
        content = clampToTokens(content, Math.floor(req.maxTokens * 0.6));
      } else if (category === "dependencies") {
        content = compressed ? renderCompressed(compressed) : readFileSafe(path);
      } else {
        content = compressed ? compressed.summary : `file: ${path}`;
      }

      const retrievalScore = aggregateRetrievalScore(cand);
      const reasons = buildBaseReasons(cand);

      items.push({
        id: `${category}:${path}`,
        path,
        category,
        content,
        tokens: estimateTokens(content),
        score: retrievalScore,
        reasons,
        compressed,
      });
    }

    return items;
  }
}

interface Candidate {
  path: string;
  hits: RetrievalHit[];
  fromActive: boolean;
  fromRecent: boolean;
}

function aggregateRetrievalScore(cand: Candidate): number {
  if (cand.fromActive) {
    return 1;
  }
  let score = 0;
  for (const h of cand.hits) {
    if (h.score > score) {
      score = h.score;
    }
  }
  if (cand.fromRecent) {
    score = Math.max(score, 0.5);
  }
  return score;
}

function buildBaseReasons(cand: Candidate) {
  const out = [];
  if (cand.fromActive) {
    out.push(reason("active", "Currently open in the editor."));
  }
  for (const h of cand.hits) {
    if (h.reason === "direct-import") {
      out.push(reason("direct-import", "Imported directly by the active file."));
    } else if (h.reason === "transitive-import") {
      out.push(
        reason(
          "transitive-import",
          `Reachable from the active file in ${h.depth} hops.`,
        ),
      );
    } else if (h.reason === "keyword-match") {
      out.push(
        reason(
          "keyword-match",
          `Header mentions terms from the task (score ${h.score.toFixed(2)}).`,
        ),
      );
    }
  }
  if (cand.fromRecent) {
    out.push(reason("recent-edit", "Edited recently in this session."));
  }
  return out;
}

function readFileSafe(path: string, override?: string): string {
  if (override !== undefined) {
    return override;
  }
  try {
    return fs.readFileSync(path, "utf8");
  } catch {
    return "";
  }
}
