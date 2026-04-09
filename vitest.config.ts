import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts", "packages/**/src/**/*.test.ts"],
    exclude: ["node_modules", "dist", "packages/on-chain"],
    timeout: 30_000, // 30s for integration tests
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["packages/*/src/**/*.ts"],
      exclude: ["**/*.test.ts", "**/index.ts"],
    },
    setupFiles: ["tests/setup.ts"],
  },
});
