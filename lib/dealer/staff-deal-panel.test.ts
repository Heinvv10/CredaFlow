import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { dealerCaptured } from "./staff-deal-panel"

// The staff panel lists the people a dealer captured, to verify their contacts;
// a person the draft purge erased has no contacts left and is not listed.
const person = (id: string, over: { createdByDealerId?: string | null; dealerPurgedAt?: Date | null } = {}) =>
  ({ id, createdByDealerId: "dealer-1", dealerPurgedAt: null, ...over })

describe("dealerCaptured", () => {
  it("lists each dealer-captured person once, never a lender-added or purged one", () => {
    const entity = { relationships: [
      { client: person("a") }, { client: person("a") }, { client: person("staff", { createdByDealerId: null }) },
      { client: person("erased", { dealerPurgedAt: new Date("2026-10-22T00:00:00Z") }) }, { client: person("b") },
    ] }
    expect(dealerCaptured(null, entity).map((p) => p.id)).toEqual(["a", "b"])
    expect(dealerCaptured(person("sole", { dealerPurgedAt: new Date() }), null)).toEqual([])
    expect(dealerCaptured(person("sole"), null).map((p) => p.id)).toEqual(["sole"])
  })
})
