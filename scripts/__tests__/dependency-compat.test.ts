import { createRequire } from "node:module"
import { describe, expect, it } from "vitest"

const require = createRequire(import.meta.url)

describe("security override compatibility", () => {
  it("keeps minimatch callable for legacy ESLint plugins", () => {
    const minimatch = require("minimatch") as ((value: string, pattern: string) => boolean) & {
      minimatch: (value: string, pattern: string) => boolean
    }

    expect(minimatch("app/page.tsx", "app/**/*.tsx")).toBe(true)
    expect(minimatch.minimatch("app/page.tsx", "app/**/*.tsx")).toBe(true)
  })

  it("keeps minimatch's default export for legacy ESLint ESM consumers", async () => {
    await expect(import("@eslint/eslintrc")).resolves.toBeDefined()
    await expect(import("@eslint/config-array")).resolves.toBeDefined()
  })

  it("keeps glob's callback and sync APIs for legacy archive dependencies", async () => {
    const glob = require("glob") as {
      (pattern: string, options: { cwd: string }, callback: (error: Error | null, matches?: string[]) => void): void
      sync(pattern: string, options: { cwd: string }): string[]
    }

    expect(glob.sync("package.json", { cwd: process.cwd() })).toEqual(["package.json"])
    await expect(new Promise<string[]>((resolve, reject) => {
      glob("package.json", { cwd: process.cwd() }, (error, matches) => error ? reject(error) : resolve(matches ?? []))
    })).resolves.toEqual(["package.json"])
  })
})
