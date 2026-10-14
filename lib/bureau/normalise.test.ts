import { describe, expect, it } from "vitest"
import { bureauInstalmentTotalCents, rawPayloadSha256, redactIdNumbers, tradelineAccounts } from "./normalise"
import type { BureauTradeline } from "./types"

const line = (instalmentCents: number, open: boolean | null): BureauTradeline => ({
  subscriber: "SYNTHETIC LENDER", accountType: "PERSONAL LOAN", instalmentCents, status: null, open,
})

describe("bureauInstalmentTotalCents", () => {
  it("sums open tradelines when the bureau states no total", () => {
    expect(bureauInstalmentTotalCents({
      statedMonthlyInstalmentCents: null,
      tradelines: [line(100_000, true), line(50_000, true)],
    })).toBe(150_000)
  })

  it("leaves closed tradelines out and counts unknown-status ones as open", () => {
    expect(bureauInstalmentTotalCents({
      statedMonthlyInstalmentCents: null,
      tradelines: [line(100_000, true), line(70_000, false), line(30_000, null)],
    })).toBe(130_000)
  })

  it("takes the bureau's stated total when it is larger than the tradelines", () => {
    expect(bureauInstalmentTotalCents({
      statedMonthlyInstalmentCents: 400_000,
      tradelines: [line(100_000, true)],
    })).toBe(400_000)
  })

  it("takes the tradelines when the stated total understates them", () => {
    expect(bureauInstalmentTotalCents({
      statedMonthlyInstalmentCents: 25_000,
      tradelines: [line(125_000, true)],
    })).toBe(125_000)
  })

  it("is null when the report says nothing about debt, and zero when it says none", () => {
    expect(bureauInstalmentTotalCents({ statedMonthlyInstalmentCents: null, tradelines: [] })).toBeNull()
    expect(bureauInstalmentTotalCents({ statedMonthlyInstalmentCents: 0, tradelines: [] })).toBe(0)
    expect(bureauInstalmentTotalCents({ statedMonthlyInstalmentCents: null, tradelines: [line(90_000, false)] })).toBe(0)
  })
})

describe("tradelineAccounts", () => {
  it("keeps exactly the four keys the credit checks read", () => {
    expect(tradelineAccounts([{ ...line(1, true), status: "OPEN" }])).toEqual([
      { subscriber: "SYNTHETIC LENDER", accountType: "PERSONAL LOAN", instalmentCents: 1, status: "OPEN" },
    ])
  })
})

describe("raw payload reference and error text", () => {
  it("hashes strings as sent and objects as JSON; nothing hashes to null", () => {
    expect(rawPayloadSha256(undefined)).toBeNull()
    expect(rawPayloadSha256("{}")).toBe(rawPayloadSha256({}))
    expect(rawPayloadSha256("abc")).toMatch(/^[0-9a-f]{64}$/)
  })

  it("redacts SA-ID-shaped digit runs from provider error text", () => {
    expect(redactIdNumbers("no match for 9001015800086 today")).toBe("no match for [id] today")
  })
})
