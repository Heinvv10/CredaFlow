import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { PORTAL_CLIENT_NAMESPACES, WEBSITE_CLIENT_NAMESPACES } from "./surfaces"

// A client component reading a namespace the layout did not send throws under
// a non-English locale (lib/i18n/client.tsx). This finds every useT("...") in
// each surface's client code and checks the layout sends it.

const ROOT = path.join(__dirname, "..", "..")

function files(rel: string): string[] {
  const abs = path.join(ROOT, rel)
  if (statSync(abs).isFile()) return [abs]
  return readdirSync(abs).flatMap((name) => {
    const child = path.join(rel, name)
    if (statSync(path.join(ROOT, child)).isDirectory()) return files(child)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path.join(ROOT, child)] : []
  })
}

function namespacesUsed(roots: string[]): string[] {
  const used = new Set<string>()
  for (const file of roots.flatMap(files)) {
    for (const match of readFileSync(file, "utf8").matchAll(/useT\("(\w+)"\)/g)) used.add(match[1])
  }
  return [...used].sort()
}

describe("client namespaces sent by each layout", () => {
  it("portal: every useT namespace is in PORTAL_CLIENT_NAMESPACES", () => {
    const used = namespacesUsed(["app/(portal)", "components/portal", "components/app-shell/PortalSidebar.tsx", "components/i18n"])
    expect(used.length).toBeGreaterThan(5)
    expect(used.filter((ns) => !(PORTAL_CLIENT_NAMESPACES as readonly string[]).includes(ns))).toEqual([])
  })

  it("website: every useT namespace is in WEBSITE_CLIENT_NAMESPACES", () => {
    const used = namespacesUsed(["app/(website)", "components/website", "components/i18n"])
    expect(used.length).toBeGreaterThan(5)
    expect(used.filter((ns) => !(WEBSITE_CLIENT_NAMESPACES as readonly string[]).includes(ns))).toEqual([])
  })
})
