import { vi } from "vitest";

/**
 * Minimal `vscode` runtime mock for unit tests.
 *
 * We only mock the pieces referenced at module-load time (e.g. logger.ts).
 * Individual tests can extend this by calling `vi.mock("vscode", ...)` in
 * the test file, but most core logic avoids `vscode` entirely.
 */
vi.mock("vscode", () => {
  const outputChannel = {
    appendLine: vi.fn(),
    show: vi.fn(),
    dispose: vi.fn(),
  };

  return {
    window: {
      createOutputChannel: vi.fn(() => outputChannel),
      showInformationMessage: vi.fn(),
      showWarningMessage: vi.fn(),
      showErrorMessage: vi.fn(),
      showInputBox: vi.fn(),
      showQuickPick: vi.fn(),
      withProgress: vi.fn(async (_opts: unknown, task: () => unknown) => task()),
    },
    workspace: {
      findFiles: vi.fn(async () => []),
      openTextDocument: vi.fn(),
      onDidSaveTextDocument: vi.fn(),
      onDidChangeActiveTextEditor: vi.fn(),
      getConfiguration: vi.fn(() => ({
        get: vi.fn((_k: string, def: unknown) => def),
      })),
    },
    commands: {
      registerCommand: vi.fn(),
    },
    ProgressLocation: {
      Notification: 15,
    },
    ViewColumn: {
      Beside: 2,
    },
  };
});

