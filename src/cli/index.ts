#!/usr/bin/env node
/**
 * ContextOS CLI
 *
 * Usage:
 *   contextos <task> [options]
 *
 * Options:
 *   -w, --workspace <path>    Workspace root (default: cwd)
 *   -f, --active-file <path>  Focal file for the engine (like "open file" in VS Code)
 *       --max-tokens <n>      Token budget (default: 8000)
 *       --max-files <n>       Max files to scan (default: 200)
 *       --max-depth <n>       Max transitive import depth (default: 2)
 *   -p, --provider <kind>     openai | anthropic | dryrun (default: dryrun)
 *   -m, --model <id>          Model identifier (default: gpt-4o-mini)
 *   -k, --api-key <key>       API key (or env: OPENAI_API_KEY / ANTHROPIC_API_KEY)
 *       --send                Call the provider and print the response to stdout
 *       --json                Print the full ScheduleResult as JSON instead of the prompt
 *   -v, --version             Print version and exit
 *   -h, --help                Print this help and exit
 *
 * Default behaviour (no --send) is dry-run: the assembled prompt is printed to
 * stdout. This is intentionally pipe-friendly — all decorative output goes to
 * stderr, all data (prompt/JSON/response) goes to stdout.
 */

import * as fs from "fs";
import * as path from "path";
import { ContextEngine } from "../context/engine";
import { send, ProviderKind } from "../provider/adapter";
import { ContextCategory, ScheduleResult } from "../utils/types";
import { FileStateStore } from "./fileState";
import { collectWorkspacePathsFromFs } from "./fileWorkspace";
import {
  printBudget,
  printError,
  printFileTable,
  printFooter,
  printHeader,
  printSending,
  printStdoutDivider,
  printTask,
} from "./ui";
import { log } from "../utils/logger";

// Silence engine internals — the UI layer renders its own diagnostic output.
log.silence();

// ---------------------------------------------------------------------------
// Arg parsing (no external deps — keeps the binary self-contained)
// ---------------------------------------------------------------------------

interface CliArgs {
  task: string;
  workspace: string;
  activeFile?: string;
  maxTokens: number;
  maxFiles: number;
  maxDepth: number;
  provider: ProviderKind;
  model: string;
  apiKey?: string;
  send: boolean;
  json: boolean;
}

function parseArgs(argv: string[]): CliArgs | null {
  const args = argv.slice(2); // drop 'node' and script path

  if (args.includes("-h") || args.includes("--help")) {
    printHelp();
    process.exit(0);
  }
  if (args.includes("-v") || args.includes("--version")) {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const pkg = require("../../package.json") as { version: string };
    process.stdout.write(`contextos ${pkg.version}\n`);
    process.exit(0);
  }

  // First non-flag argument is the task.
  let task: string | undefined;
  const flags: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("-") && task === undefined) {
      task = args[i];
    } else {
      flags.push(args[i]);
    }
  }

  if (!task) {
    process.stderr.write("error: task argument is required.\n\n");
    printHelp();
    process.exit(1);
  }

  const get = (short: string, long: string): string | undefined => {
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === short || flags[i] === long) {
        return flags[i + 1];
      }
      const prefix = `${long}=`;
      if (flags[i].startsWith(prefix)) {
        return flags[i].slice(prefix.length);
      }
    }
    return undefined;
  };

  const has = (short: string, long: string): boolean =>
    flags.includes(short) || flags.includes(long);

  const rawWorkspace = get("-w", "--workspace");
  const workspace = rawWorkspace ? path.resolve(rawWorkspace) : process.cwd();

  const rawActiveFile = get("-f", "--active-file");
  const activeFile = rawActiveFile
    ? path.isAbsolute(rawActiveFile)
      ? rawActiveFile
      : path.resolve(workspace, rawActiveFile)
    : undefined;

  const rawProvider = get("-p", "--provider") as ProviderKind | undefined;
  const provider: ProviderKind = rawProvider ?? "dryrun";
  if (!["openai", "anthropic", "dryrun"].includes(provider)) {
    printError(`unknown provider "${provider}". Expected: openai | anthropic | dryrun`);
  }

  const rawApiKey = get("-k", "--api-key");
  const apiKey =
    rawApiKey ??
    (provider === "openai" ? process.env["OPENAI_API_KEY"] : undefined) ??
    (provider === "anthropic" ? process.env["ANTHROPIC_API_KEY"] : undefined);

  return {
    task,
    workspace,
    activeFile,
    maxTokens: parseInt(get("", "--max-tokens") ?? "8000", 10),
    maxFiles: parseInt(get("", "--max-files") ?? "200", 10),
    maxDepth: parseInt(get("", "--max-depth") ?? "2", 10),
    provider,
    model: get("-m", "--model") ?? "gpt-4o-mini",
    apiKey,
    send: has("", "--send"),
    json: has("", "--json"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  if (!args) {
    process.exit(1);
  }

  if (!fs.existsSync(args.workspace)) {
    printError(`workspace path does not exist: ${args.workspace}`);
  }
  if (args.activeFile && !fs.existsSync(args.activeFile)) {
    printError(`active-file path does not exist: ${args.activeFile}`);
  }

  // Print header immediately so the terminal feels responsive.
  if (!args.json) {
    printHeader(args.workspace);
    printTask(args.task);
  }

  const state = new FileStateStore(args.workspace);
  const workspacePaths = collectWorkspacePathsFromFs(args.workspace, args.maxFiles);

  const budgetSplit: Record<ContextCategory, number> = {
    activeFile: 0.35,
    dependencies: 0.30,
    summaries: 0.20,
    history: 0.15,
  };

  const engine = new ContextEngine(state);
  const result: ScheduleResult = await engine.run({
    task: args.task,
    activeFilePath: args.activeFile,
    activeFileContent: args.activeFile ? readFileSafe(args.activeFile) : undefined,
    recentlyEditedPaths: [],
    workspacePaths,
    maxDependencyDepth: args.maxDepth,
    maxTokens: args.maxTokens,
    budgetSplit,
  });

  state.recordHistory({
    timestamp: Date.now(),
    task: args.task,
    promptTokens: result.totalTokensUsed,
    includedPaths: result.decisions.filter((d) => d.included).map((d) => d.item.path),
  });

  // --- JSON mode: no UI, just data -----------------------------------------
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  // --- Print the context overview ------------------------------------------
  printBudget(result.totalTokensUsed, result.maxTokens, result.categories);
  printFileTable(result.decisions, args.workspace);

  // --- Dry-run / prompt-to-stdout ------------------------------------------
  if (!args.send || args.provider === "dryrun") {
    printStdoutDivider("prompt → stdout");
    process.stdout.write(result.prompt + "\n");
    printFooter(result);
    return;
  }

  // --- Live provider call --------------------------------------------------
  if (!args.apiKey) {
    printError(
      `--send requires an API key. ` +
      `Pass --api-key or set ${args.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}.`,
    );
  }

  printSending(args.provider, args.model);
  const response = await send(args.provider, {
    prompt: result.prompt,
    model: args.model,
    apiKey: args.apiKey,
  });

  printStdoutDivider("response → stdout");
  process.stdout.write(response.text + "\n");
  printFooter(result);
}

function readFileSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function printHelp(): void {
  process.stdout.write(`
contextos <task> [options]

  Schedule context for an AI coding task and print the assembled prompt.
  Decorative output → stderr  ·  prompt / JSON / response → stdout

Options:
  -w, --workspace <path>    Workspace root (default: current directory)
  -f, --active-file <path>  Focal file — equivalent to the open file in VS Code
      --max-tokens <n>      Token budget (default: 8000)
      --max-files <n>       Max workspace files to scan (default: 200)
      --max-depth <n>       Max transitive import depth (default: 2)
  -p, --provider <kind>     openai | anthropic | dryrun (default: dryrun)
  -m, --model <id>          Model identifier (default: gpt-4o-mini)
  -k, --api-key <key>       API key (or env: OPENAI_API_KEY / ANTHROPIC_API_KEY)
      --send                Call the provider; print response to stdout
      --json                Print full ScheduleResult as JSON
  -v, --version             Print version
  -h, --help                Print this help

Examples:
  contextos "add error handling to fetchUser" -f src/api/user.ts
  contextos "fix the off-by-one in paginate" -w /path/to/repo --json
  contextos "refactor auth" -p openai --send
  contextos "add tests for parseQuery" | pbcopy
`.trimStart());
}

main().catch((err: unknown) => {
  printError(err instanceof Error ? err.message : String(err));
});
