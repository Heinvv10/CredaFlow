import { readFileSync, readdirSync, statSync } from "fs"
import path from "path"
import { describe, expect, it } from "vitest"

/**
 * sonner's toast() writes into a store that renders nothing until a <Toaster />
 * subscribes to it. The app shipped without that mount, so every toast in the
 * staff and portal apps was a silent no-op: blocked actions (the KYC gate on
 * Start Review, for one) failed with no user-visible reason at all.
 *
 * A test that mocks @/lib/toast and asserts "toast.error was called" passes in
 * exactly that broken state, so it cannot guard this. Assert the mount itself,
 * and assert the root layout renders its provider so every route is covered.
 */

const ROOT = path.resolve(__dirname, "..", "..")

function readSource(relativePath: string): string {
  return readFileSync(path.join(ROOT, relativePath), "utf8")
}

function collectTsx(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) collectTsx(full, found)
    else if (entry.endsWith(".tsx")) found.push(path.relative(ROOT, full))
  }
  return found
}

describe("sonner Toaster mount", () => {
  it("is mounted by the provider rendered in the root layout", () => {
    const layout = readSource("app/layout.tsx")
    const provider = readSource("components/ThemeProvider.tsx")

    expect(layout).toMatch(/import\s*\{[^}]*\bThemeProvider\b[^}]*\}/)
    expect(layout).toMatch(/<ThemeProvider\b/)
    expect(provider).toMatch(/import\s*\{[^}]*\bToaster\b[^}]*\}\s*from\s*["']sonner["']/)
    expect(provider).toMatch(/<Toaster\b/)
  })

  it("is the only mount, so toasts never render twice", () => {
    const mounts = [
      ...collectTsx(path.join(ROOT, "app")),
      ...collectTsx(path.join(ROOT, "components")),
    ]
      .filter((file) => /<Toaster\b/.test(readSource(file)))

    expect(mounts).toEqual(["components/ThemeProvider.tsx"])
  })

  it("renders the same library the app's toast helper dispatches to", () => {
    // The mount is only wired to the callers if both halves are sonner. Swap
    // lib/toast to another library and every toast goes silent again while a
    // sonner Toaster still sits in the tree, looking correct.
    const helper = readSource("lib/toast.ts")
    const provider = readSource("components/ThemeProvider.tsx")

    const helperImports = [...helper.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])
    const providerToasterImport = provider.match(
      /import\s*\{[^}]*\bToaster\b[^}]*\}\s*from\s*["']([^"']+)["']/,
    )?.[1]

    expect(providerToasterImport).toBeDefined()
    expect(helperImports).toContain(providerToasterImport)
  })
})
