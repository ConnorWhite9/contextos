import * as vscode from "vscode";
import { ScheduleResult } from "../utils/types";

/**
 * Webview-based preview panel.
 *
 * Responsibilities:
 *   - Show included vs excluded items with reasons.
 *   - Show per-category token usage with bars.
 *   - Show the assembled prompt verbatim.
 *
 * The panel is reused across invocations — calling `show()` updates the
 * existing panel rather than spawning new ones. This matches the mental
 * model of a single "what's the model seeing right now?" view.
 */

export class PreviewPanel {
  private static current: PreviewPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  static show(result: ScheduleResult): void {
    if (PreviewPanel.current) {
      PreviewPanel.current.panel.reveal(vscode.ViewColumn.Beside, true);
      PreviewPanel.current.render(result);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      "contextos.preview",
      "ContextOS Preview",
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      {
        enableScripts: false,
        retainContextWhenHidden: true,
      },
    );
    PreviewPanel.current = new PreviewPanel(panel);
    PreviewPanel.current.render(result);
  }

  private constructor(panel: vscode.WebviewPanel) {
    this.panel = panel;
    this.panel.onDidDispose(
      () => {
        PreviewPanel.current = undefined;
        for (const d of this.disposables) {
          d.dispose();
        }
      },
      null,
      this.disposables,
    );
  }

  render(result: ScheduleResult): void {
    this.panel.webview.html = buildHtml(result);
  }
}

function buildHtml(r: ScheduleResult): string {
  const included = r.decisions.filter((d) => d.included);
  const excluded = r.decisions.filter((d) => !d.included);

  const catRows = r.categories
    .map((c) => {
      const pct = c.allocated === 0 ? 0 : Math.min(100, Math.round((c.used / c.allocated) * 100));
      return `
        <tr>
          <td>${escapeHtml(c.category)}</td>
          <td class="num">${c.items}</td>
          <td class="num">${c.used}</td>
          <td class="num">${c.allocated}</td>
          <td class="bar-cell">
            <div class="bar"><div class="bar-fill" style="width:${pct}%"></div></div>
          </td>
        </tr>
      `;
    })
    .join("");

  const renderItems = (items: typeof r.decisions): string =>
    items
      .map((d) => {
        const reasons = d.item.reasons
          .map((r) => `<li><span class="reason-code">${escapeHtml(r.code)}</span> ${escapeHtml(r.detail)}</li>`)
          .join("");
        const excluded = d.excludedBecause
          ? `<div class="excluded-why">Excluded: ${escapeHtml(d.excludedBecause)}</div>`
          : "";
        return `
          <div class="item">
            <div class="item-head">
              <span class="cat cat-${escapeHtml(d.item.category)}">${escapeHtml(d.item.category)}</span>
              <span class="path">${escapeHtml(d.item.path)}</span>
              <span class="score">score ${d.item.score.toFixed(2)}</span>
              <span class="tokens">${d.item.tokens} tok</span>
            </div>
            ${reasons ? `<ul class="reasons">${reasons}</ul>` : ""}
            ${excluded}
          </div>
        `;
      })
      .join("");

  return /* html */ `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>ContextOS Preview</title>
  <style>
    body {
      font-family: var(--vscode-editor-font-family, monospace);
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      padding: 16px;
      line-height: 1.45;
    }
    h1, h2, h3 { margin: 0 0 8px 0; }
    h1 { font-size: 18px; }
    h2 { font-size: 14px; margin-top: 20px; border-bottom: 1px solid var(--vscode-panel-border); padding-bottom: 4px; }
    .meta { color: var(--vscode-descriptionForeground); font-size: 12px; }
    table { border-collapse: collapse; width: 100%; margin: 8px 0 16px 0; font-size: 12px; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid var(--vscode-panel-border); }
    td.num { text-align: right; font-variant-numeric: tabular-nums; }
    .bar { width: 100%; height: 8px; background: var(--vscode-input-background); border-radius: 3px; overflow: hidden; }
    .bar-fill { height: 100%; background: var(--vscode-progressBar-background, #0e639c); }
    .bar-cell { width: 30%; }
    .item { padding: 8px 10px; margin-bottom: 6px; border-left: 3px solid transparent; background: var(--vscode-editorWidget-background); border-radius: 3px; }
    .item-head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font-size: 12px; }
    .path { font-weight: 600; }
    .score, .tokens { color: var(--vscode-descriptionForeground); }
    .cat { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; padding: 1px 6px; border-radius: 2px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
    .cat-activeFile { background: #0e639c; color: white; }
    .cat-dependencies { background: #6a4caf; color: white; }
    .cat-summaries { background: #3a7a3a; color: white; }
    .cat-history { background: #8a6d1a; color: white; }
    .reasons { margin: 6px 0 0 0; padding-left: 18px; font-size: 11px; color: var(--vscode-descriptionForeground); }
    .reason-code { display: inline-block; min-width: 120px; color: var(--vscode-textLink-foreground); }
    .excluded-why { margin-top: 4px; font-size: 11px; color: var(--vscode-errorForeground); }
    pre.prompt { white-space: pre-wrap; font-size: 11px; background: var(--vscode-textCodeBlock-background); padding: 10px; border-radius: 4px; max-height: 60vh; overflow: auto; }
    .kpis { display: flex; gap: 20px; margin: 6px 0 14px 0; }
    .kpi { font-size: 12px; }
    .kpi b { display: block; font-size: 18px; }
  </style>
</head>
<body>
  <h1>ContextOS Preview</h1>
  <div class="meta">Task: ${escapeHtml(r.task)}</div>

  <div class="kpis">
    <div class="kpi"><b>${r.totalTokensUsed}</b>tokens used</div>
    <div class="kpi"><b>${r.maxTokens}</b>budget</div>
    <div class="kpi"><b>${included.length}</b>included</div>
    <div class="kpi"><b>${excluded.length}</b>excluded</div>
    <div class="kpi"><b>${r.elapsedMs}ms</b>scheduled in</div>
  </div>

  <h2>Token budget by category</h2>
  <table>
    <thead><tr><th>category</th><th class="num">items</th><th class="num">used</th><th class="num">allocated</th><th>fill</th></tr></thead>
    <tbody>${catRows}</tbody>
  </table>

  <h2>Included (${included.length})</h2>
  ${included.length ? renderItems(included) : "<div class='meta'>Nothing included — check your budget or active file.</div>"}

  <h2>Excluded (${excluded.length})</h2>
  ${excluded.length ? renderItems(excluded) : "<div class='meta'>Nothing excluded.</div>"}

  <h2>Assembled Prompt</h2>
  <pre class="prompt">${escapeHtml(r.prompt)}</pre>
</body>
</html>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
