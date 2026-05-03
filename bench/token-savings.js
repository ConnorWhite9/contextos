/* eslint-disable @typescript-eslint/no-var-requires */
/**
 * Quick local benchmark:
 *
 * Compare token usage for two strategies given an "active file":
 *   - naive: active file + full text of direct imports
 *   - optimized: active file + AST-compressed direct imports
 *
 * This uses the compiled extension code in `out/` so it matches what the
 * VS Code extension actually runs.
 */

const fs = require("fs");
const path = require("path");

const { estimateTokens } = require("../out/utils/tokens");
const { compressFile, renderCompressed } = require("../out/ast/compressor");
const { importGraphWithResolver } = require("../out/retrieval/retriever");

function read(p) {
  return fs.readFileSync(p, "utf8");
}

function runCase(activeRel) {
  const root = process.cwd();
  const activeAbs = path.resolve(root, activeRel);

  const activeText = read(activeAbs);
  const hits = importGraphWithResolver(activeAbs, 1, (p) => fs.existsSync(p));
  const deps = hits.filter((h) => h.depth === 1).map((h) => h.path);

  const naiveParts = [
    "Task: Refactor and improve behavior",
    `Active file: ${activeRel}`,
    activeText,
  ];
  for (const d of deps) {
    naiveParts.push(`Dependency: ${path.relative(root, d)}`);
    naiveParts.push(read(d));
  }
  const naivePrompt = naiveParts.join("\n");

  const optParts = [
    "Task: Refactor and improve behavior",
    `Active file: ${activeRel}`,
    activeText,
  ];
  for (const d of deps) {
    const c = compressFile(d);
    optParts.push(`Dependency (compressed): ${path.relative(root, d)}`);
    optParts.push(c ? renderCompressed(c) : read(d));
  }
  const optPrompt = optParts.join("\n");

  const naiveTokens = estimateTokens(naivePrompt);
  const optimizedTokens = estimateTokens(optPrompt);
  const tokensSaved = naiveTokens - optimizedTokens;
  const percentReduction = naiveTokens
    ? Number(((tokensSaved / naiveTokens) * 100).toFixed(1))
    : 0;

  return {
    active: activeRel,
    directDependencies: deps.length,
    naiveTokens,
    optimizedTokens,
    tokensSaved,
    percentReduction,
  };
}

function summarize(results) {
  const reductions = results
    .map((r) => r.percentReduction)
    .sort((a, b) => a - b);
  const min = reductions[0] ?? 0;
  const max = reductions[reductions.length - 1] ?? 0;
  const avg =
    reductions.length > 0
      ? Number(
          (
            reductions.reduce((sum, x) => sum + x, 0) / reductions.length
          ).toFixed(1)
        )
      : 0;
  return { min, max, avg };
}

function main() {
  const cases = [
    "src/context/engine.ts",
    "src/ast/compressor.ts",
    "src/retrieval/retriever.ts",
    "src/context/budgeter.ts",
    "src/prompt/builder.ts",
  ];

  const results = cases.map(runCase);
  const stats = summarize(results);

  const payload = {
    repo: path.basename(process.cwd()),
    strategy:
      "naive(active + full direct imports) vs optimized(active + compressed direct imports)",
    tokenEstimator: "estimateTokens(chars/4)",
    cases: results,
    summary: stats,
  };

  console.log(JSON.stringify(payload, null, 2));
}

main();

