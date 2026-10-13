import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    globalSetup: ["test/global-setup.ts"],
    testTimeout: 20_000,
    hookTimeout: 60_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/main.ts", "src/db/migrate.ts"],
      reporter: ["text-summary", "text"],
      // PLAN §5.2：modules/identity、modules/records、sync/* 覆蓋率 ≥ 85%
      thresholds: {
        "src/modules/identity/**": { lines: 85, statements: 85, functions: 85, branches: 70 },
        "src/modules/records/**": { lines: 85, statements: 85, functions: 85, branches: 70 },
        "src/sync/**": { lines: 85, statements: 85, functions: 85, branches: 70 },
      },
    },
  },
});
