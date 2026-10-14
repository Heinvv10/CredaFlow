import { describe, expect, it } from "vitest"
import {
  CONSECUTIVE_NPF_LIMIT,
  MAX_PRESENTMENTS_PER_CYCLE,
  consecutiveNpf,
  nextPresentmentNo,
  suspensionReason,
  validateMandateTerms,
  type ResultFact,
} from "./scheme-rules"

const npf = (day: string): ResultFact => ({ outcome: "UNPAID", reasonCode: "INSUFFICIENT_FUNDS", resolvedAt: new Date(`${day}T08:00:00Z`) })
const paid = (day: string): ResultFact => ({ outcome: "PAID", reasonCode: null, resolvedAt: new Date(`${day}T08:00:00Z`) })

describe("scheme constants", () => {
  it("caps presentments at two per instalment per cycle and suspends after two consecutive NPFs", () => {
    expect(MAX_PRESENTMENTS_PER_CYCLE).toBe(2)
    expect(CONSECUTIVE_NPF_LIMIT).toBe(2)
  })
})

describe("consecutiveNpf", () => {
  it("counts the unbroken run of insufficient-funds unpaids, newest first, whatever the input order", () => {
    expect(consecutiveNpf([npf("2026-10-26"), paid("2026-09-25"), npf("2026-11-25")])).toBe(2)
  })

  it("is reset by a paid collection", () => {
    expect(consecutiveNpf([npf("2026-09-25"), npf("2026-10-26"), paid("2026-11-25")])).toBe(0)
  })

  it("does not count an unpaid for another reason as an NPF, and that unpaid breaks the run", () => {
    const closed: ResultFact = { outcome: "UNPAID", reasonCode: "UNKNOWN", resolvedAt: new Date("2026-11-25T08:00:00Z") }
    expect(consecutiveNpf([npf("2026-10-26"), closed])).toBe(0)
  })
})

describe("suspensionReason", () => {
  it("suspends after two consecutive NPFs and not after one", () => {
    expect(suspensionReason([npf("2026-10-26")])).toBeNull()
    expect(suspensionReason([npf("2026-10-26"), npf("2026-11-25")])).toMatch(/2 consecutive/)
  })

  it("suspends at once on a hard-stop reason or a dispute", () => {
    expect(suspensionReason([{ outcome: "UNPAID", reasonCode: "ACCOUNT_CLOSED", resolvedAt: new Date() }])).toMatch(/ACCOUNT_CLOSED/)
    expect(suspensionReason([{ outcome: "DISPUTED", reasonCode: "PAYMENT_STOPPED", resolvedAt: new Date() }])).toMatch(/disputed/i)
  })

  it("does not suspend when the latest collection was paid", () => {
    expect(suspensionReason([npf("2026-09-25"), paid("2026-10-26")])).toBeNull()
  })
})

describe("nextPresentmentNo", () => {
  it("is 1 for an instalment never presented", () => {
    expect(nextPresentmentNo([])).toBe(1)
  })

  it("is 2 after a first presentment came back NPF", () => {
    expect(nextPresentmentNo([{ presentmentNo: 1, status: "UNPAID", reasonCode: "INSUFFICIENT_FUNDS" }])).toBe(2)
  })

  it("refuses a third presentment", () => {
    expect(nextPresentmentNo([
      { presentmentNo: 1, status: "UNPAID", reasonCode: "INSUFFICIENT_FUNDS" },
      { presentmentNo: 2, status: "UNPAID", reasonCode: "INSUFFICIENT_FUNDS" },
    ])).toBeNull()
  })

  it("never re-presents while one is in flight, after a payment, a dispute or a provider rejection", () => {
    for (const status of ["PENDING", "SUBMITTING", "SUBMITTED", "PAID", "DISPUTED", "REJECTED"] as const) {
      expect(nextPresentmentNo([{ presentmentNo: 1, status, reasonCode: null }])).toBeNull()
    }
  })

  it("never re-presents after a hard-stop unpaid", () => {
    expect(nextPresentmentNo([{ presentmentNo: 1, status: "UNPAID", reasonCode: "ACCOUNT_CLOSED" }])).toBeNull()
  })

  it("ignores a cancelled instruction: it never reached the bank", () => {
    expect(nextPresentmentNo([{ presentmentNo: 1, status: "CANCELLED", reasonCode: null }])).toBe(1)
  })
})

describe("validateMandateTerms", () => {
  const ok = { amountCents: 100_000, maxAmountCents: 150_000, debitDay: 25, trackingDays: 3 }
  it("accepts terms inside the scheme limits", () => {
    expect(validateMandateTerms(ok)).toBeNull()
  })

  it.each([
    [{ trackingDays: 0 }, /tracking/i],
    [{ trackingDays: 11 }, /tracking/i],
    [{ debitDay: 0 }, /debit day/i],
    [{ debitDay: 32 }, /debit day/i],
    [{ amountCents: 0 }, /amount/i],
    [{ maxAmountCents: 99_999 }, /maximum/i],
    [{ maxAmountCents: 150_001 }, /1\.5/],
    [{ amountCents: 100_000.5 }, /amount/i],
  ])("refuses %o", (patch, message) => {
    expect(validateMandateTerms({ ...ok, ...patch })).toMatch(message)
  })
})
