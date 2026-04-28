import { defineConfig } from "vitest/config";

/**
 * Vitest config for ContextOS.
 *
 * The extension code imports `vscode` in a few modules (logger, state, UI).
 * In unit tests we run in plain Node, so we provide a minimal runtime mock
 * in `test/setup.ts` to avoid requiring the real VS Code host environment.
 */
export default defineConfig({
  test: {
    environment: "node",
    setupFiles: ["./test/setup.ts"],
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      reportsDirectory: "./coverage",
      reporter: ["text", "html", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/extension.ts",
        "src/commands/**",
        "src/ui/**",
      ],
    },
  },
});

