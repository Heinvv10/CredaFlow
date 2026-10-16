import { describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ identity: vi.fn(), brand: vi.fn() }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: h.identity, getLenderBrandName: h.brand }))

import { portalMetadata } from "./portal-metadata"

describe("portalMetadata", () => {
  it("titles portal tabs with the lender's trading name, and a page's own title in front", async () => {
    h.identity.mockResolvedValue({ tradingName: "Fair Score" })
    expect(await portalMetadata("t1")).toEqual({
      title: { default: "Client portal — Fair Score", template: "%s · Client portal — Fair Score" },
    })
  })

  it("falls back to the brand name before the identity is configured", async () => {
    h.identity.mockResolvedValue(null)
    h.brand.mockResolvedValue("Acme")
    expect(await portalMetadata("t1")).toEqual({ title: { default: "Client portal — Acme", template: "%s · Client portal — Acme" } })
  })

  it("never says workspace, even with no tenant", async () => {
    expect(await portalMetadata(null)).toEqual({ title: "Client portal" })
  })
})
