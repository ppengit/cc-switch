import path from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./tests/setupGlobals.ts", "./tests/setupTests.ts"],
    globals: true,
    fileParallelism: false,
    testTimeout: 15_000,
    exclude: [...configDefaults.exclude, ".worktrees/**"],
    coverage: {
      reporter: ["text", "lcov"],
    },
  },
});
