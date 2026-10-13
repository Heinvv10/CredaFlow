import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { unstable_doesMiddlewareMatch } from "next/experimental/testing/server"

vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))
const { config } = await import("./proxy")

// The audience gate (client host = portal + public pages only) and the CLIENT
// role gate live in proxy.ts, so they hold only for requests the matcher sends
// there. A dynamic segment can take any value, including one that ends in an
// image extension the matcher skips: /clients/x.png reaches the staff tree on
// the client host without the proxy ever running.
const APP_DIR = path.join(__dirname, "app")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? walk(full) : [full]
  })
}

/** URL of a page or route handler whose LAST segment is dynamic, set to an image-like value. */
function imageLikeUrlOf(file: string): string | null {
  const rel = path.relative(APP_DIR, file).split(path.sep)
  const leaf = rel.pop()!
  if (leaf !== "page.tsx" && leaf !== "route.ts") return null
  const segments = rel.filter((s) => !/^\(.*\)$/.test(s))
  const last = segments[segments.length - 1]
  if (!last || !/^\[.*\]$/.test(last)) return null
  return "/" + segments.map((s, i) => (i === segments.length - 1 ? "x.png" : /^\[.*\]$/.test(s) ? "x" : s)).join("/")
}

const URLS = [...new Set(walk(APP_DIR).map(imageLikeUrlOf).filter((u): u is string => u !== null))]
  // Public one-time links and NextAuth's own handler self-gate by design.
  .filter((u) => !/^\/(pasq|selfie)\//.test(u) && !u.startsWith("/api/auth/") && !u.startsWith("/api/pasq-link/"))

describe("proxy matcher", () => {
  it("finds the dynamic routes it checks", () => {
    expect(URLS).toContain("/clients/x.png")
    expect(URLS).toContain("/api/clients/x.png")
  })

  it.each(URLS)("runs the proxy for %s", (url) => {
    expect(unstable_doesMiddlewareMatch({ config, url })).toBe(true)
  })
})
