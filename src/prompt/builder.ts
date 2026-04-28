import {
  BudgetDecision,
  ContextState,
  ScheduleResult,
} from "../utils/types";
import { renderCompressed } from "../ast/compressor";
import { estimateTokens } from "../utils/tokens";

/**
 * Prompt assembly.
 *
 * The model reads top-to-bottom and weights earlier tokens more heavily,
 * so we put structural information first and summaries last. Sections are
 * stable — the preview panel relies on the same layout for highlighting.
 */

export interface PromptInputs {
  task: string;
  decisions: BudgetDecision[];
  state: ContextState;
}

export interface BuiltPrompt {
  prompt: string;
  includedPaths: string[];
  tokens: number;
}

export function buildPrompt(inputs: PromptInputs): BuiltPrompt {
  const { task, decisions, state } = inputs;
  const included = decisions.filter((d) => d.included).map((d) => d.item);

  // Group by category so we can render distinct sections.
  const activeFileItems = included.filter((i) => i.category === "activeFile");
  const depItems = included.filter((i) => i.category === "dependencies");
  const summaryItems = included.filter((i) => i.category === "summaries");

  const sections: string[] = [];

  sections.push("## Task", task.trim(), "");

  if (state.invariants.length > 0 || state.workingMemory.length > 0) {
    sections.push("## Constraints");
    for (const inv of state.invariants) {
      sections.push(`- ${inv}`);
    }
    for (const note of state.workingMemory) {
      sections.push(`- (note) ${note}`);
    }
    sections.push("");
  }

  // Types across all included files, collected before Functions so type
  // definitions precede their use sites in the prompt.
  const allTypes: string[] = [];
  const allSignatures: string[] = [];
  // Avoid double-billing tokens from the active file: we include the full
  // source later in the prompt, so we don't also lift its signatures/types
  // into the early \"Relevant\" sections.
  for (const item of [...depItems, ...summaryItems]) {
    if (item.compressed) {
      if (item.compressed.types.length > 0) {
        allTypes.push(`// ${item.compressed.path}`);
        allTypes.push(item.compressed.types.join("\n"));
      }
      if (item.compressed.signatures.length > 0) {
        allSignatures.push(`// ${item.compressed.path}`);
        allSignatures.push(item.compressed.signatures.join("\n"));
      }
    }
  }

  if (allTypes.length > 0) {
    sections.push("## Relevant Types", "```ts", allTypes.join("\n"), "```", "");
  }

  if (allSignatures.length > 0) {
    sections.push(
      "## Relevant Functions",
      "```ts",
      allSignatures.join("\n"),
      "```",
      "",
    );
  }

  if (activeFileItems.length > 0) {
    sections.push("## Active File");
    for (const item of activeFileItems) {
      sections.push(`### ${item.path}`, "```ts", item.content, "```", "");
    }
  }

  if (depItems.length > 0) {
    sections.push("## Dependencies");
    for (const item of depItems) {
      const body = item.compressed
        ? renderCompressed(item.compressed)
        : item.content;
      sections.push(`### ${item.path}`, "```ts", body, "```", "");
    }
  }

  if (summaryItems.length > 0) {
    sections.push("## Summaries");
    for (const item of summaryItems) {
      const summary = item.compressed
        ? item.compressed.summary
        : item.content.slice(0, 240);
      sections.push(`- ${summary}`);
    }
    sections.push("");
  }

  if (state.history.length > 0) {
    const recent = state.history.slice(-3);
    sections.push("## Recent Tasks");
    for (const h of recent) {
      sections.push(`- ${new Date(h.timestamp).toISOString()}: ${h.task}`);
    }
    sections.push("");
  }

  const prompt = sections.join("\n").replace(/\n{3,}/g, "\n\n").trimEnd() + "\n";

  return {
    prompt,
    includedPaths: included.map((i) => i.path),
    tokens: estimateTokens(prompt),
  };
}

/** Bare-minimum fallback if nothing survived the budget. */
export function buildFallbackPrompt(task: string): ScheduleResult["prompt"] {
  return `## Task\n${task.trim()}\n`;
}
