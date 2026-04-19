import * as vscode from "vscode";
import { ContextEngine } from "../context/engine";
import { ContextStateStore } from "../context/state";
import { PreviewPanel } from "../ui/previewPanel";
import { send, ProviderKind } from "../provider/adapter";
import { collectWorkspacePaths, recentEdits } from "./workspace";
import { log } from "../utils/logger";
import { ContextCategory } from "../utils/types";

/**
 * Command implementations.
 *
 * These are thin: they translate VS Code state (config, active editor,
 * secret storage) into engine inputs, run the engine, and route the
 * output either to the preview panel or to the provider adapter.
 */

interface RunOptions {
  dryRunOverride: boolean;
}

export async function runGenerate(
  context: vscode.ExtensionContext,
  state: ContextStateStore,
  opts: RunOptions,
): Promise<void> {
  const config = vscode.workspace.getConfiguration("contextos");
  const maxTokens = config.get<number>("maxTokens", 8000);
  const maxFiles = config.get<number>("maxFilesScanned", 200);
  const providerKind = config.get<ProviderKind>("provider", "dryrun");
  const model = config.get<string>("model", "gpt-4o-mini");
  const dryRunSetting = config.get<boolean>("dryRun", false);
  const splitRaw = config.get<Record<string, number>>("budgetSplit", {
    activeFile: 0.35,
    dependencies: 0.3,
    summaries: 0.2,
    history: 0.15,
  });
  const split = normalizeSplit(splitRaw);

  const task = await vscode.window.showInputBox({
    prompt: "What would you like the model to do?",
    placeHolder: "e.g. add error handling to fetchUser",
  });
  if (!task) {
    return;
  }

  const editor = vscode.window.activeTextEditor;
  const activeFilePath = editor?.document.uri.fsPath;
  const activeFileContent = editor?.document.getText();

  const workspacePaths = await collectWorkspacePaths(maxFiles);

  const engine = new ContextEngine(state);
  const result = await engine.run({
    task,
    activeFilePath,
    activeFileContent,
    recentlyEditedPaths: recentEdits.list(),
    workspacePaths,
    maxTokens,
    budgetSplit: split,
  });

  PreviewPanel.show(result);

  // Record the task in history whether or not we actually send it.
  state.recordHistory({
    timestamp: Date.now(),
    task,
    promptTokens: result.totalTokensUsed,
    includedPaths: result.decisions.filter((d) => d.included).map((d) => d.item.path),
  });

  const isDryRun = opts.dryRunOverride || dryRunSetting || providerKind === "dryrun";
  if (isDryRun) {
    vscode.window.showInformationMessage(
      `ContextOS: dry run — ${result.totalTokensUsed}/${maxTokens} tokens. See Preview.`,
    );
    return;
  }

  const apiKey = await context.secrets.get(apiKeySecretName(providerKind));
  if (!apiKey) {
    vscode.window.showWarningMessage(
      `ContextOS: no API key for ${providerKind}. Run 'ContextOS: Set API Key' first.`,
    );
    return;
  }

  try {
    const response = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: "ContextOS: calling provider…" },
      () => send(providerKind, { prompt: result.prompt, model, apiKey }),
    );
    await showResponse(task, response.text);
  } catch (err) {
    log.error("provider.send failed", err);
    vscode.window.showErrorMessage(
      `ContextOS: provider call failed — ${(err as Error).message}`,
    );
  }
}

export async function runPreview(
  _context: vscode.ExtensionContext,
  state: ContextStateStore,
): Promise<void> {
  // Preview == generate with dry-run forced on.
  await runGenerate(_context, state, { dryRunOverride: true });
}

export async function runSetApiKey(context: vscode.ExtensionContext): Promise<void> {
  const providerKind = await vscode.window.showQuickPick(
    ["openai", "anthropic"],
    { placeHolder: "Which provider is this key for?" },
  );
  if (!providerKind) {
    return;
  }
  const key = await vscode.window.showInputBox({
    prompt: `Paste your ${providerKind} API key (stored locally in SecretStorage)`,
    password: true,
    ignoreFocusOut: true,
  });
  if (!key) {
    return;
  }
  await context.secrets.store(apiKeySecretName(providerKind as ProviderKind), key);
  vscode.window.showInformationMessage(
    `ContextOS: ${providerKind} API key stored in SecretStorage.`,
  );
}

function apiKeySecretName(kind: ProviderKind): string {
  return `contextos.apiKey.${kind}`;
}

/**
 * Coerce a loosely-typed settings object into the strict
 * `Record<ContextCategory, number>` the engine expects.
 */
function normalizeSplit(
  raw: Record<string, number>,
): Record<ContextCategory, number> {
  return {
    activeFile: Number(raw.activeFile ?? 0.35),
    dependencies: Number(raw.dependencies ?? 0.3),
    summaries: Number(raw.summaries ?? 0.2),
    history: Number(raw.history ?? 0.15),
  };
}

async function showResponse(task: string, text: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: `# Task\n${task}\n\n# Response\n${text}\n`,
    language: "markdown",
  });
  await vscode.window.showTextDocument(doc, { preview: false });
}
