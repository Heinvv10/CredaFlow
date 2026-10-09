import { describe, it, expect } from "vitest"
import { needsCommissionAttention } from "./attention"

const ev = (commissionStatus: string, qualityFlag: string | null) => ({ commissionStatus, qualityFlag })

describe("needsCommissionAttention", () => {
  it("counts an event with a flag set and no exclusion match", () => {
    expect(needsCommissionAttention(ev("PENDING", "MANUAL_REVIEW"))).toBe(true)
  })

  it("excludes UNMATCHED_CODE — it already has its own attention row", () => {
    expect(needsCommissionAttention(ev("PENDING", "UNMATCHED_CODE"))).toBe(false)
  })

  it("excludes APPROVED — a resolved quality decision", () => {
    expect(needsCommissionAttention(ev("PAYABLE", "APPROVED"))).toBe(false)
  })

  // OWNER RULING (2026-08-06): BLOCKED is a resolved staff decision exactly as
  // APPROVED is — leaving it in would nag forever about something a human
  // already decided. commissionStatus carries BLOCKED, not qualityFlag.
  it("excludes BLOCKED — a resolved staff decision", () => {
    expect(needsCommissionAttention(ev("BLOCKED", "LOW_QUALITY"))).toBe(false)
  })

  it("excludes REVERSED — a reversed row can carry a stale qualityFlag", () => {
    expect(needsCommissionAttention(ev("REVERSED", "LOW_QUALITY"))).toBe(false)
  })

  it("excludes an event with no flag set", () => {
    expect(needsCommissionAttention(ev("PENDING", null))).toBe(false)
  })
})
