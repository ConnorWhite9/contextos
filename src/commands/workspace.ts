import * as vscode from "vscode";
import { isTypeScriptLike } from "../utils/paths";

/**
 * VS Code glue: collect candidate workspace paths and recent-edit paths.
 *
 * We deliberately do NOT do a full repo scan on every invocation — the
 * scheduler target is <150ms. Instead we:
 *   - cap results at `maxFiles`
 *   - exclude `node_modules`, `out`, `dist`, `.git` via VS Code's globs
 *   - skip non-TS files at the outer boundary
 *
 * If the workspace has multiple folders, we scan all of them.
 */

const EXCLUDE =
  "{**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.git/**,**/.vscode-test/**}";

export async function collectWorkspacePaths(maxFiles: number): Promise<string[]> {
  const uris = await vscode.workspace.findFiles(
    "**/*.{ts,tsx,js,jsx}",
    EXCLUDE,
    maxFiles,
  );
  return uris.map((u) => u.fsPath).filter(isTypeScriptLike);
}

/**
 * Track "recently edited" as a rolling window of paths the user has
 * modified in this editor session. We subscribe in `extension.ts` and
 * query via this module.
 */
class RecentEdits {
  private paths: string[] = [];
  private readonly cap = 20;

  push(path: string): void {
    this.paths = [path, ...this.paths.filter((p) => p !== path)].slice(0, this.cap);
  }

  list(): string[] {
    return [...this.paths];
  }
}

export const recentEdits = new RecentEdits();

export function wireRecentEdits(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (isTypeScriptLike(doc.uri.fsPath)) {
        recentEdits.push(doc.uri.fsPath);
      }
    }),
  );
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((ed) => {
      if (ed && isTypeScriptLike(ed.document.uri.fsPath)) {
        recentEdits.push(ed.document.uri.fsPath);
      }
    }),
  );
}
