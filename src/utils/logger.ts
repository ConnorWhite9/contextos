import * as vscode from "vscode";

/**
 * Thin wrapper over a VS Code OutputChannel.
 *
 * Keeping logging in one place means every subsystem (engine, compressor,
 * provider) writes to the same "ContextOS" pane, which is important for
 * debugging scheduling decisions without attaching a debugger.
 */
class Logger {
  private channel: vscode.OutputChannel | undefined;
  private silent = false;

  init(channel: vscode.OutputChannel): void {
    this.channel = channel;
  }

  /** Suppress all output — used by the CLI to keep stderr clean. */
  silence(): void {
    this.silent = true;
  }

  info(msg: string): void {
    this.write("INFO", msg);
  }

  warn(msg: string): void {
    this.write("WARN", msg);
  }

  error(msg: string, err?: unknown): void {
    const suffix = err instanceof Error ? ` :: ${err.message}` : "";
    this.write("ERR ", msg + suffix);
  }

  time<T>(label: string, fn: () => T): T {
    const start = Date.now();
    try {
      return fn();
    } finally {
      this.info(`${label} took ${Date.now() - start}ms`);
    }
  }

  async timeAsync<T>(label: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      return await fn();
    } finally {
      this.info(`${label} took ${Date.now() - start}ms`);
    }
  }

  private write(level: string, msg: string): void {
    if (this.silent) {
      return;
    }
    const line = `[${new Date().toISOString()}] ${level} ${msg}`;
    if (this.channel) {
      this.channel.appendLine(line);
    } else {
      // Fallback for pre-activation, test, and CLI contexts.
      // stderr keeps diagnostic output separate from CLI stdout data.
      console.error(line);
    }
  }
}

export const log = new Logger();
