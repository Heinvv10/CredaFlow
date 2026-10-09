import { describe, it, expect, vi } from "vitest"
import fs from "node:fs"
import path from "node:path"

vi.mock("next/navigation", () => ({ useSearchParams: () => null }))

import { TAB_VALUES, resolveWhatsAppTab } from "./WhatsAppSettingsClient"

// The ?tab= deep-link validates against a hand-written TAB_VALUES list. The
// bridge outage alert email points admins at Settings -> WhatsApp -> Bridge
// as plain text (no link), but staff bookmark or type ?tab=bridge from it —
// a tab renamed without updating the list would silently land on Status
// instead during an outage.
describe("WhatsAppSettingsClient tab deep-linking", () => {
  const source = fs.readFileSync(path.join(__dirname, "WhatsAppSettingsClient.tsx"), "utf8")
  const rendered = [...source.matchAll(/<TabsTrigger value="([^"]+)"/g)].map((m) => m[1])

  it("declares every tab that is actually rendered", () => {
    expect(TAB_VALUES.length).toBeGreaterThan(0)
    expect([...TAB_VALUES].sort()).toEqual([...rendered].sort())
  })

  it("accepts the bridge tab named in the outage alert email", () => {
    expect(resolveWhatsAppTab("bridge")).toBe("bridge")
  })

  it("falls back to status rather than rendering an empty panel", () => {
    expect(resolveWhatsAppTab("wa-bridge")).toBe("status")
    expect(resolveWhatsAppTab("")).toBe("status")
    expect(resolveWhatsAppTab(null)).toBe("status")
  })
})
