import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/asset-finance/lease-portal-route", () => ({ clientLeaseRefusal: vi.fn() }))

import { PORTAL_PACE_LIMIT, paceCeiling } from "@/lib/asset-finance/meter-readings"
import { PACE_TABLE } from "./__fixtures__/pace-table"

// The ceiling an unattended tracker reading (and a portal reading) may not
// pass: the start reading plus PORTAL_PACE_LIMIT times the yearly allowance,
// pro rata from the start reading's date, with a month's grace. The SQL twin
// telematicsPaceCeiling is compared with this table on a real database in
// lib/telematics/meter-route.integration.test.ts.
describe("paceCeiling", () => {
  it("is the portal's limit, three times the contracted pace", () => {
    expect(PORTAL_PACE_LIMIT).toBe(3)
  })
  it.each(PACE_TABLE)("start $start on $startDate, allowance $allowance: $ceiling on $on", ({ start, startDate, on, allowance, ceiling }) => {
    expect(paceCeiling({ value: start, readingDate: startDate }, on, allowance)).toBe(ceiling)
  })
})
