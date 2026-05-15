import * as path from "path";
import * as os from "os";
import { BudgetDecision, CategoryUsage, ScheduleResult } from "../utils/types";

/**
 * Terminal UI for the ContextOS CLI.
 *
 * All output goes to stderr so stdout remains clean for piped data
 * (prompt text, JSON, provider responses).
 *
 * Colors are enabled only when stderr is an interactive TTY.
 */

const TTY = process.stderr.isTTY === true;

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const A = {
  reset:        TTY ? "\x1b[0m"  : "",
  bold:         TTY ? "\x1b[1m"  : "",
  dim:          TTY ? "\x1b[2m"  : "",
  green:        TTY ? "\x1b[32m" : "",
  cyan:         TTY ? "\x1b[36m" : "",
  yellow:       TTY ? "\x1b[33m" : "",
  blue:         TTY ? "\x1b[34m" : "",
  magenta:      TTY ? "\x1b[35m" : "",
  red:          TTY ? "\x1b[31m" : "",
  brightGreen:  TTY ? "\x1b[92m" : "",
  brightCyan:   TTY ? "\x1b[96m" : "",
  brightWhite:  TTY ? "\x1b[97m" : "",
};

function bold(s: string): string  { return `${A.bold}${s}${A.reset}`; }
function dim(s: string): string   { return `${A.dim}${s}${A.reset}`; }
function green(s: string): string { return `${A.green}${s}${A.reset}`; }
function cyan(s: string): string  { return `${A.cyan}${s}${A.reset}`; }
function yellow(s: string): string { return `${A.yellow}${s}${A.reset}`; }
function red(s: string): string   { return `${A.red}${s}${A.reset}`; }
function brightCyan(s: string): string { return `${A.brightCyan}${s}${A.reset}`; }

// ---------------------------------------------------------------------------
// Low-level output
// ---------------------------------------------------------------------------

function err(line: string): void {
  process.stderr.write(line + "\n");
}

function blank(): void {
  process.stderr.write("\n");
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Abbreviate home directory to ~ */
function shortenHome(p: string): string {
  const home = os.homedir();
  return p.startsWith(home) ? "~" + p.slice(home.length) : p;
}

/** Make a path relative to workspace; truncate with leading … if too long. */
function relPath(filePath: string, workspace: string, maxLen = 44): string {
  const rel = path.relative(workspace, filePath);
  if (rel.length <= maxLen) return rel;
  return "…" + rel.slice(-(maxLen - 1));
}

/** Right-align a string within `width` chars (plain text). */
function rpad(s: string, width: number): string {
  return s.length >= width ? s : " ".repeat(width - s.length) + s;
}

/** Left-align a string, padding to `width` chars (plain text). */
function lpad(s: string, width: number): string {
  return s.length >= width ? s.slice(0, width) : s + " ".repeat(width - s.length);
}

/** Render a visual token bar (filled/empty blocks). */
function tokenBar(used: number, max: number, width = 22): string {
  const pct = Math.min(used / max, 1);
  const filled = Math.round(pct * width);
  const empty = width - filled;
  const bar = "█".repeat(filled) + "░".repeat(empty);
  return TTY
    ? `${A.cyan}${"█".repeat(filled)}${A.reset}${A.dim}${"░".repeat(empty)}${A.reset}`
    : bar;
}

/** Category display config. */
function categoryLabel(cat: string): string {
  switch (cat) {
    case "activeFile":  return TTY ? `${A.bold}${A.brightGreen}active${A.reset}  ` : "active  ";
    case "dependencies": return TTY ? `${A.cyan}dep${A.reset}     ` : "dep     ";
    case "summaries":   return TTY ? `${A.dim}summary${A.reset} ` : "summary ";
    case "history":     return TTY ? `${A.dim}history${A.reset} ` : "history ";
    default:            return lpad(cat, 8);
  }
}

/** Bullet icon for each category. */
function categoryIcon(cat: string): string {
  switch (cat) {
    case "activeFile":   return TTY ? `${A.bold}${A.brightGreen}◆${A.reset}` : "◆";
    case "dependencies": return TTY ? `${A.cyan}●${A.reset}` : "●";
    default:             return TTY ? `${A.dim}·${A.reset}` : "·";
  }
}

/** Divider line. */
function divider(label = "", width = 60): string {
  if (!label) return dim("─".repeat(width));
  const pad = Math.max(0, width - label.length - 2);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  const inner = "─".repeat(left) + " " + label + " " + "─".repeat(right);
  return dim(inner);
}

// ---------------------------------------------------------------------------
// Public UI surface
// ---------------------------------------------------------------------------

/** Print the branded header with workspace path. */
export function printHeader(workspace: string): void {
  blank();
  err(`  ${bold(brightCyan("contextos"))}  ${dim("·")}  ${dim(shortenHome(workspace))}`);
  blank();
}

/** Print the task line. */
export function printTask(task: string): void {
  err(`  ${TTY ? A.bold + A.brightGreen : ""}✦${A.reset}  ${bold(task)}`);
  blank();
}

/** Print the token budget bar + per-category breakdown. */
export function printBudget(totalUsed: number, maxTokens: number, usage: CategoryUsage[]): void {
  const pct = Math.round((totalUsed / maxTokens) * 100);
  // Cap bar fill at 100% visually; over-budget shows full bar in red.
  const bar = pct > 100
    ? (TTY ? `\x1b[31m${"█".repeat(22)}\x1b[0m` : "█".repeat(22))
    : tokenBar(totalUsed, maxTokens);

  const usedStr = totalUsed.toLocaleString();
  const maxStr  = maxTokens.toLocaleString();
  const pctStr  = pct > 100
    ? red(`${pct}%  ↑ prompt overhead`)
    : pct >= 90 ? red(`${pct}%`)
    : pct >= 70 ? yellow(`${pct}%`) : cyan(`${pct}%`);

  err(`  ${dim("budget")}  ${bar}  ${bold(usedStr)} ${dim("/")} ${dim(maxStr)} tokens  ${pctStr}`);

  // Per-category mini bars
  const catLine = usage
    .filter((u) => u.allocated > 0)
    .map((u) => {
      const pctCat = u.allocated > 0 ? Math.round((u.used / u.allocated) * 100) : 0;
      const label = u.category === "activeFile" ? "active" :
                    u.category === "dependencies" ? "dep" :
                    u.category === "summaries" ? "summary" : "history";
      return dim(label) + " " + tokenBar(u.used, u.allocated, 8) + " " + dim(`${pctCat}%`);
    })
    .join("   ");

  if (catLine) {
    err(`  ${" ".repeat(8)}${catLine}`);
  }
  blank();
}

/** Print the included + excluded file table. */
export function printFileTable(decisions: BudgetDecision[], workspace: string): void {
  const included = decisions.filter((d) => d.included);
  const excluded = decisions.filter((d) => !d.included);

  err(`  ${dim("context")}  ${bold(String(included.length))} included  ${dim("·")}  ${dim(excluded.length + " excluded")}`);
  blank();

  for (const d of included) {
    const icon  = categoryIcon(d.item.category);
    const label = categoryLabel(d.item.category);
    const p     = relPath(d.item.path, workspace);
    const tok   = rpad(d.item.tokens.toLocaleString(), 5);
    const score = d.item.score.toFixed(2);

    err(
      `  ${icon}  ${label}  ${lpad(p, 44)}  ` +
      `${dim(tok)} tok  ${yellow(score)}`,
    );
  }

  if (excluded.length > 0) {
    blank();
    // Group exclusion reasons
    const reasons = new Map<string, number>();
    for (const d of excluded) {
      const key = d.excludedBecause?.startsWith("Too large")
        ? "too large"
        : d.excludedBecause ?? "unknown";
      reasons.set(key, (reasons.get(key) ?? 0) + 1);
    }
    const reasonStr = [...reasons.entries()]
      .map(([r, n]) => `${r} (${n})`)
      .join("  ·  ");
    err(`  ${dim("╌")}  ${dim(`${excluded.length} excluded`)}  ${dim("·")}  ${dim(reasonStr)}`);
  }

  blank();
}

/** Print a status line before piping to an external tool. */
export function printPipe(target: string, resolvedCmd: string): void {
  const label = target === resolvedCmd ? target : `${target} ${dim("→")} ${resolvedCmd}`;
  err(`  ${cyan("⟶")}  Piping to ${bold(label)}${dim("…")}`);
  blank();
}

/** Print a status line before sending to a provider. */
export function printSending(provider: string, model: string): void {
  err(`  ${cyan("●")}  Sending to ${bold(provider + "/" + model)}${dim("…")}`);
  blank();
}

/** Print a divider announcing what's arriving on stdout. */
export function printStdoutDivider(label: string): void {
  err(divider(dim(label)));
  blank();
}

/** Print a compact success footer. */
export function printFooter(result: ScheduleResult): void {
  err(
    `  ${dim("✓")}  ${dim(`${result.elapsedMs}ms`)}` +
    `  ${dim("·")}  ${dim(`${result.totalTokensUsed.toLocaleString()} tokens used`)}` +
    `  ${dim("·")}  ${dim(`${result.decisions.filter((d) => d.included).length} files`)}`,
  );
  blank();
}

/** Print an error and exit. */
export function printError(msg: string): never {
  blank();
  err(`  ${red("✗")}  ${msg}`);
  blank();
  process.exit(1);
}
