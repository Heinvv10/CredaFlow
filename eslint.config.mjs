import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Utility scripts — not part of the app bundle
    "docs/**",
    "prisma/seed*.ts",
    // Not app source: nested git worktrees (each a full second repo copy —
    // linting them OOMs eslint) and the codegraph index dir.
    ".claude/**",
    ".codegraph/**",
  ]),
  // Type-aware: a promise that is dropped or read as its result is a bug the type checker misses when the result
  // is only tested for truth. Introduced with the async rate limiter (lib/rate-limit.ts), where a missed `await`
  // turned a login limit into `Promise.allowed` (undefined, i.e. refuse or allow by accident).
  {
    files: ["app/api/**/*.ts", "app/**/route.ts", "lib/**/*.ts", "proxy.ts"],
    ignores: ["**/*.test.{ts,tsx}", "**/*.integration.test.ts", "**/*.test-helpers.ts", "**/*-fixture.ts"],
    languageOptions: { parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname } },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      // Conditionals (`if (promise)`) are the risk here; passing async handlers to callbacks and JSX attributes is
      // idiomatic and has too many existing sites to gate in this change.
      "@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
    },
  },
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
        caughtErrorsIgnorePattern: "^_",
      }],
    },
  },
]);

export default eslintConfig;
