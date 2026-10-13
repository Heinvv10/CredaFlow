import { configDefaults, defineConfig } from "vitest/config"
import path from "path"

export default defineConfig({
  test: {
    environment: "node",
    globals: false,
    // Pinned to UTC deliberately, and NOT to Africa/Johannesburg. Dev boxes
    // here run SAST, so a test asserting SAST-correct behaviour passes even
    // when the code drops its timeZone argument — the machine supplies it. A
    // zone that differs from the product's is the only setting under which a
    // missing `timeZone: SAST_TIME_ZONE` actually fails.
    // DEMO_LENDER unset, whatever the shell exports: the demo suites pin the
    // default lender (prisma/demo-lender.ts).
    env: { TZ: "UTC", DEMO_LENDER: "" },
    // Git worktrees are full checkouts of this repo living INSIDE it, each with
    // its own node_modules. Without these excludes, `npm test` in the primary
    // checkout recursively discovers every worktree's suites and runs them
    // against a second, mismatched dependency tree. Measured at 872b2d23 with
    // one worktree present: discovery found 2994 files, 2514 of them nested;
    // excluded, it finds 480 project files and none nested. Collection can also
    // abort outright — a nested route resolving `@/...` against the wrong root
    // raises ERR_MODULE_NOT_FOUND, and `vitest list` then returns nothing.
    //
    // `.next/**` is DEFENSIVE, not a fix for an observed failure: today the
    // standalone output holds no project test files outside node_modules, which
    // configDefaults already excludes. It guards against build output that
    // copies source back into itself.
    exclude: [
      ...configDefaults.exclude,
      "**/.claude/**",
      "**/.worktrees/**",
      "**/.next/**",
    ],
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "."),
    },
  },
})
