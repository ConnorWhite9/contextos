import * as vscode from "vscode";
import { log } from "./utils/logger";
import { ContextStateStore } from "./context/state";
import { runGenerate, runPreview, runSetApiKey } from "./commands/generate";
import { wireRecentEdits } from "./commands/workspace";
import { clearAstCache } from "./ast/parser";

/**
 * Extension entry point.
 *
 * We keep activation cheap: create the output channel, wire the state
 * store to workspaceState, register commands, and subscribe to the
 * minimum set of events we need for recency tracking. All heavy work
 * (AST parsing, prompt building) is deferred to the first command call.
 */

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("ContextOS");
  log.init(channel);
  context.subscriptions.push(channel);

  const state = new ContextStateStore(context.workspaceState);

  wireRecentEdits(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("contextos.generate", () =>
      runGenerate(context, state, { dryRunOverride: false }),
    ),
    vscode.commands.registerCommand("contextos.preview", () =>
      runPreview(context, state),
    ),
    vscode.commands.registerCommand("contextos.setApiKey", () =>
      runSetApiKey(context),
    ),
    vscode.commands.registerCommand("contextos.clearCache", () => {
      clearAstCache();
      vscode.window.showInformationMessage("ContextOS: AST cache cleared.");
    }),
  );

  log.info("ContextOS activated.");
}

export function deactivate(): void {
  log.info("ContextOS deactivated.");
}
