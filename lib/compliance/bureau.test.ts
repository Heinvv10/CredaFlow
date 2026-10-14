import { describe, expect, it } from "vitest"
import {
  APPROVAL_BUREAU_PROVIDERS,
  BUREAU_STALENESS_DAYS,
  DEFAULT_BUREAU_MAX_AGE_DAYS,
  approvalBureauCheckWhere,
  bureauMaxAgeDays,
  bureauStalenessCutoff,
} from "./bureau"

const DAY = 24 * 60 * 60 * 1000
const now = new Date("2026-10-14T10:00:00.000Z")

/** Mirrors the database read: a check counts when createdAt >= cutoff. */
const usable = (ageDays: number, maxAgeDays: number) =>
  new Date(now.getTime() - ageDays * DAY) >= bureauStalenessCutoff(maxAgeDays, now)

describe("bureau report freshness", () => {
  it("defaults to the 60-day ceiling (unchanged for existing tenants); a tenant may only tighten it", () => {
    expect(DEFAULT_BUREAU_MAX_AGE_DAYS).toBe(60)
    expect(bureauMaxAgeDays(null)).toBe(60)
    expect(bureauMaxAgeDays({})).toBe(60)
    expect(bureauMaxAgeDays({ bureauMaxAgeDays: 14 })).toBe(14)
    expect(bureauMaxAgeDays({ bureauMaxAgeDays: 365 })).toBe(BUREAU_STALENESS_DAYS)
    expect(bureauMaxAgeDays({ bureauMaxAgeDays: 0 })).toBe(1)
  })

  it("a report older than the tenant's window cannot support approval", () => {
    expect(usable(29, 30)).toBe(true)
    expect(usable(30, 30)).toBe(true)
    expect(usable(31, 30)).toBe(false)
    expect(usable(15, 14)).toBe(false)
    // The ceiling holds whatever is asked for.
    expect(usable(61, 90)).toBe(false)
  })

  it("the approval read binds the generation, success, the window and the approval bureaus", () => {
    const where = approvalBureauCheckWhere({
      tenantId: "t", applicationId: "a", clientId: "c", reviewGeneration: "g", maxAgeDays: 30, now,
    })
    expect(where).toEqual({
      tenantId: "t", applicationId: "a", clientId: "c", reviewGeneration: "g", ok: true,
      createdAt: { gte: new Date(now.getTime() - 30 * DAY) },
      provider: { in: ["experian", "simulated"] },
    })
    expect(APPROVAL_BUREAU_PROVIDERS).not.toContain("transunion")
  })
})
