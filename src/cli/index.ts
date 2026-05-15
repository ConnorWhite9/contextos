#!/usr/bin/env node
/**
 * ContextOS CLI
 *
 * Quick start (three steps, then forget):
 *   1. npm run compile
 *   2. npm link           ← installs `contextos` globally
 *   3. contextos "task"   ← run from any repo
 *
 * Or without linking:
 *   ./ctx "task"          ← shell wrapper in repo root
 *   npm run ctx -- "task" ← npm script
 *
 * Workspace config  .contextos.json  (optional, checked in or gitignored):
 *   {
 *     "activeFile": "src/api/user.ts",
 *     "pipe":       "claude",
 *     "maxTokens":  12000
 *   }
 *
 * Options:
 *   -f, --active-file <path>  Focal file (like the open file in VS Code)
 *   -w, --workspace <path>    Workspace root (default: cwd)
 *       --pipe <target>       Pipe prompt to: claude | pbcopy | xclip | clip | <cmd>
 *       --max-tokens <n>      Token budget (default: 8000)
 *       --max-files <n>       Max files scanned (default: 200)
 *       --max-depth <n>       Max import depth (default: 2)
 *   -p, --provider <kind>     openai | anthropic | dryrun (default: dryrun)
 *   -m, --model <id>          Model identifier (default: gpt-4o-mini)
 *   -k, --api-key <key>       API key (or OPENAI_API_KEY / ANTHROPIC_API_KEY)
 *       --send                Call the provider; print response to stdout
 *       --json                Print full ScheduleResult as JSON
 *   -v, --version             Print version
 *   -h, --help                Print this help
 */

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { ContextEngine } from "../context/engine";
import { send, ProviderKind } from "../provider/adapter";
import { ContextCategory, ScheduleResult } from "../utils/types";
import { FileStateStore } from "./fileState";
import { collectWorkspacePathsFromFs } from "./fileWorkspace";
import { log } from "../utils/logger";
import {
  printBudget,
  printError,
  printFileTable,
  printFooter,
  printHeader,
  printPipe,
  printSending,
  printStdoutDivider,
  printTask,
} from "./ui";

// Silence engine internals — the UI layer renders its own diagnostic output.
log.silence();

// ---------------------------------------------------------------------------
// Config file
// ---------------------------------------------------------------------------

interface ContextosConfig {
  /** Shell target to pipe the prompt into. Named aliases: claude, pbcopy, xclip, clip. */
  pipe?: string;
  /** Default active file, relative to workspace root. */
  activeFile?: string;
  maxTokens?: number;
  maxFiles?: number;
  maxDepth?: number;
  provider?: ProviderKind;
  model?: string;
}

function loadConfig(workspace: string): ContextosConfig {
  const candidates = [
    path.join(workspace, ".contextos.json"),
    path.join(workspace, ".contextos", "config.json"),
  ];
  for (const p of candidates) {
    try {
      return JSON.parse(fs.readFileSync(p, "utf8")) as ContextosConfig;
    } catch {
      // file not found or invalid — silently ignore
    }
  }
  return {};
}

// ---------------------------------------------------------------------------
// Named pipe targets
// ---------------------------------------------------------------------------

/**
 * Well-known short names → full shell commands.
 * Users can also pass any arbitrary shell command string as `--pipe`.
 */
const NAMED_PIPES: Record<string, string> = {
  claude:   "claude",
  pbcopy:   "pbcopy",                        // macOS clipboard
  xclip:    "xclip -selection clipboard",    // Linux/X11 clipboard
  xsel:     "xsel --clipboard --input",      // Linux/X11 alt
  "wl-copy": "wl-copy",                      // Wayland clipboard
  clip:     "clip",                          // Windows clipboard
};

function resolvePipeTarget(target: string): string {
  return NAMED_PIPES[target] ?? target;
}

/** Spawn `cmd` with `input` on stdin, inheriting stdout/stderr. */
async function pipeToCommand(cmd: string, input: string): Promise<void> {
  const parts = cmd.trim().split(/\s+/);
  const bin = parts[0];
  const binArgs = parts.slice(1);

  return new Promise((resolve, reject) => {
    const proc = spawn(bin, binArgs, {
      stdio: ["pipe", "inherit", "inherit"],
      shell: false,
    });
    proc.on("error", (err) => reject(new Error(`could not start "${bin}": ${err.message}`)));
    proc.on("close", (code) => {
      if (code === 0 || code === null) resolve();
      else reject(new Error(`"${bin}" exited with code ${code}`));
    });
    proc.stdin.write(input, "utf8");
    proc.stdin.end();
  });
}

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

interface CliArgs {
  task: string;
  workspace: string;
  activeFile?: string;
  pipe?: string;
  maxTokens: number;
  maxFiles: number;
  maxDepth: number;
  provider: ProviderKind;
  model: string;
  apiKey?: string;
  send: boolean;
  json: boolean;
}

function parseArgs(argv: string[], config: ContextosConfig): CliArgs | null {
  const args = argv.slice(2);

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

  let task: string | undefined;
  const flags: string[] = [];
  for (const arg of args) {
    if (!arg.startsWith("-") && task === undefined) {
      task = arg;
    } else {
      flags.push(arg);
    }
  }

  if (!task) {
    process.stderr.write("error: task argument is required.\n\n");
    printHelp();
    process.exit(1);
  }

  const get = (short: string, long: string): string | undefined => {
    for (let i = 0; i < flags.length; i++) {
      if (flags[i] === short || flags[i] === long) return flags[i + 1];
      const prefix = `${long}=`;
      if (flags[i].startsWith(prefix)) return flags[i].slice(prefix.length);
    }
    return undefined;
  };

  const has = (short: string, long: string): boolean =>
    flags.includes(short) || flags.includes(long);

  const rawWorkspace = get("-w", "--workspace");
  const workspace = rawWorkspace ? path.resolve(rawWorkspace) : process.cwd();

  // CLI flag wins; else config file; else nothing.
  const rawActiveFile = get("-f", "--active-file") ?? config.activeFile;
  const activeFile = rawActiveFile
    ? path.isAbsolute(rawActiveFile)
      ? rawActiveFile
      : path.resolve(workspace, rawActiveFile)
    : undefined;

  const rawProvider = (get("-p", "--provider") ?? config.provider) as ProviderKind | undefined;
  const provider: ProviderKind = rawProvider ?? "dryrun";
  if (!["openai", "anthropic", "dryrun"].includes(provider)) {
    printError(`unknown provider "${provider}". Expected: openai | anthropic | dryrun`);
  }

  const rawApiKey = get("-k", "--api-key");
  const apiKey =
    rawApiKey ??
    (provider === "openai" ? process.env["OPENAI_API_KEY"] : undefined) ??
    (provider === "anthropic" ? process.env["ANTHROPIC_API_KEY"] : undefined);

  // --pipe: CLI flag wins, then config, then nothing.
  const rawPipe = get("", "--pipe") ?? config.pipe;

  return {
    task,
    workspace,
    activeFile,
    pipe: rawPipe,
    maxTokens: parseInt(get("", "--max-tokens") ?? String(config.maxTokens ?? 8000), 10),
    maxFiles:  parseInt(get("", "--max-files")  ?? String(config.maxFiles  ?? 200),   10),
    maxDepth:  parseInt(get("", "--max-depth")  ?? String(config.maxDepth  ?? 2),     10),
    provider,
    model:   get("-m", "--model") ?? config.model ?? "gpt-4o-mini",
    apiKey,
    send:    has("", "--send"),
    json:    has("", "--json"),
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  // Load config from workspace first so parseArgs can merge it.
  const workspace = (() => {
    const w = process.argv.findIndex((a) => a === "-w" || a === "--workspace");
    return w !== -1 && process.argv[w + 1]
      ? path.resolve(process.argv[w + 1])
      : process.cwd();
  })();

  const config = loadConfig(workspace);
  const args = parseArgs(process.argv, config);
  if (!args) process.exit(1);

  if (!fs.existsSync(args.workspace)) {
    printError(`workspace path does not exist: ${args.workspace}`);
  }
  if (args.activeFile && !fs.existsSync(args.activeFile)) {
    printError(`active-file path does not exist: ${args.activeFile}`);
  }

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

  // --- JSON mode -----------------------------------------------------------
  if (args.json) {
    process.stdout.write(JSON.stringify(result, null, 2) + "\n");
    return;
  }

  printBudget(result.totalTokensUsed, result.maxTokens, result.categories);
  printFileTable(result.decisions, args.workspace);

  // --- Pipe mode: send prompt to an external tool --------------------------
  if (args.pipe) {
    const cmd = resolvePipeTarget(args.pipe);
    printPipe(args.pipe, cmd);
    await pipeToCommand(cmd, result.prompt);
    printFooter(result);
    return;
  }

  // --- Provider send -------------------------------------------------------
  if (args.send && args.provider !== "dryrun") {
    if (!args.apiKey) {
      printError(
        `--send requires an API key. Pass --api-key or set ` +
        `${args.provider === "openai" ? "OPENAI_API_KEY" : "ANTHROPIC_API_KEY"}.`,
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
    return;
  }

  // --- Default: prompt to stdout (pipe-friendly dry-run) ------------------
  printStdoutDivider("prompt → stdout");
  process.stdout.write(result.prompt + "\n");
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

  Schedule context for an AI coding task. Decorative UI → stderr, data → stdout.

Usage after setup:
  contextos "task"                  reads .contextos.json for defaults
  contextos "task" | claude         pipe directly to Claude Code
  contextos "task" --pipe claude    same, declared inline
  contextos "task" --pipe pbcopy    copy prompt to clipboard (macOS)

Setup (one time):
  npm run compile && npm link       installs 'contextos' globally
  echo '{"pipe":"claude"}' > .contextos.json   set workspace defaults

Options:
  -f, --active-file <path>   Focal file (like the open file in VS Code)
  -w, --workspace <path>     Workspace root (default: cwd)
      --pipe <target>        claude | pbcopy | xclip | clip | <any shell cmd>
      --max-tokens <n>       Token budget (default: 8000)
      --max-files <n>        Max workspace files to scan (default: 200)
      --max-depth <n>        Max import depth (default: 2)
  -p, --provider <kind>      openai | anthropic | dryrun (default: dryrun)
  -m, --model <id>           Model name (default: gpt-4o-mini)
  -k, --api-key <key>        API key (or env: OPENAI_API_KEY / ANTHROPIC_API_KEY)
      --send                 Call the provider; stream response to stdout
      --json                 Emit full ScheduleResult as JSON
  -v, --version              Print version
  -h, --help                 Print this help

Config file  .contextos.json  (workspace root, CLI flags override):
  {
    "activeFile": "src/api/user.ts",   // default focal file
    "pipe":       "claude",            // always pipe to this target
    "maxTokens":  12000
  }
`.trimStart());
}

main().catch((err: unknown) => {
  printError(err instanceof Error ? err.message : String(err));
});
