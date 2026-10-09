import { describe, it, expect } from "vitest"
import fs from "node:fs"
import path from "node:path"
import { legacyTabRedirect } from "./CommsSettingsClient"

// The ?tab= deep-link validates against a hand-written TAB_VALUES list. A tab
// renamed without updating the list silently lands on "Channel" instead.
describe("CommsSettingsClient tab deep-linking", () => {
  const source = fs.readFileSync(path.join(__dirname, "CommsSettingsClient.tsx"), "utf8")

  const declared = JSON.parse(
    (source.match(/const TAB_VALUES = (\[[^\]]*\])/) ?? [])[1]?.replace(/'/g, '"') ?? "[]",
  ) as string[]
  const rendered = [...source.matchAll(/<TabsTrigger value="([^"]+)"/g)].map((m) => m[1])

  it("declares every tab that is actually rendered", () => {
    expect(declared.length).toBeGreaterThan(0)
    expect([...declared].sort()).toEqual([...rendered].sort())
  })

  it("no longer owns the WhatsApp bridge tab", () => {
    expect(declared).not.toContain("wa-bridge")
  })
})

// The alert email itself is plain text with no link — this redirect instead
// protects bookmarks and typed URLs still pointing at
// /settings/comms?tab=wa-bridge. That tab is gone; without this redirect one
// of those lands on Channel with no bridge in sight, exactly when an admin
// is trying to fix the bridge.
describe("legacy wa-bridge deep link", () => {
  it("sends the old bridge link to the WhatsApp bridge tab", () => {
    expect(legacyTabRedirect("wa-bridge")).toBe("/settings/whatsapp?tab=bridge")
  })

  it("leaves every live tab alone", () => {
    expect(legacyTabRedirect("channel")).toBeNull()
    expect(legacyTabRedirect("roster")).toBeNull()
    expect(legacyTabRedirect(null)).toBeNull()
  })

  // The helper is only a decision; assert it is actually wired to the router,
  // since this suite deliberately does not render Radix Tabs (node env).
  it("is wired to a router replace in the component", () => {
    const source = fs.readFileSync(path.join(__dirname, "CommsSettingsClient.tsx"), "utf8")
    expect(source).toMatch(/router\.replace\(\s*legacyTab\s*\)/)
  })

  // The client-side redirect above only fires after CommsSettingsClient
  // mounts and runs an effect — a bookmarked or typed ?tab=wa-bridge URL
  // still renders this page's DB-backed content for a beat first. The
  // server component must redirect before that ever happens.
  it("page.tsx redirects server-side before any client render", () => {
    const source = fs.readFileSync(path.join(__dirname, "page.tsx"), "utf8")
    expect(source).toContain('redirect("/settings/whatsapp?tab=bridge")')
  })
})
