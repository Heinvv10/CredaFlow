import { afterEach, describe, expect, it } from "vitest"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { approvalInterestCapCheck, checkRepeatShortTermFor } from "@/lib/loan/nca-interest-cap.server"
import { loanProductCreateCapRefusal, loanProductUpdateCapRefusal } from "@/lib/product-config/interest-cap"
import { interestGuidance } from "@/lib/product-config/interest-guidance"
import { affordabilityExpenseEvidenceNeedsMleJustification } from "@/lib/affordability/snapshot"
import { resetActiveJurisdiction, setActiveJurisdiction } from "./active"

// A database that fails the test if the gate lets a query through.
const noDb = new Proxy({}, { get: (_t, name) => { throw new Error(`unexpected database access: ${String(name)}`) } }) as never

const loan = { status: "DEFAULTED", ncaRegime: "NCA" as const, arrearsAmount: 5000, outstandingPrincipal: 90000, daysInArrears: 120 }
const application = {
  id: "app-1", ncaRegime: "NCA", clientId: "client-1", appliedAmount: 500_000, appliedTermDays: 90,
  product: { interestRatePm: 0.30, interestModel: "FLAT" },
}
const product = { maxAmount: 500_000, maxTermDays: 90, interestRatePm: 0.30, interestModel: "FLAT" }
const belowMle = { mle: { belowMinimum: true, justification: null } } as never
const preview = { productType: "LOAN", amountRand: 5000, termDays: 90, ratePercentPm: 30, interestModel: "FLAT" }

afterEach(() => resetActiveJurisdiction())

describe("ZA keeps every NCA gate", () => {
  it("expenses below the Regulation 23A minimum need a written justification", () => {
    expect(affordabilityExpenseEvidenceNeedsMleJustification(belowMle)).toBe(true)
  })

  it("Section 129 is available once 90 days in arrears", () => {
    expect(evaluateCollectionsEligibility(loan, "SECTION_129")).toMatchObject({ eligible: true })
  })

  it("approval is held to the rate cap, here 30% a month against the 5% short-term ceiling", async () => {
    const shortTerm = { ...application, appliedAmount: 500_000 }
    // No repo needed for a short-term transaction; the database is not read for the cap itself.
    const result = await approvalInterestCapCheck({ referenceRate: {}, loan: {}, loanApplication: {} } as never, "t1", shortTerm)
    expect(result).toMatchObject({ ok: false, reason: "ABOVE_CAP" })
  })

  it("a product priced above the cap is refused", async () => {
    expect(await loanProductCreateCapRefusal("t1", product)).toMatchObject({ invalidFields: ["interestRatePm"] })
  })

  it("the product form warns on an over-cap preview", () => {
    expect(interestGuidance(preview).warning).toBe(true)
  })
})

describe("LS skips the NCA-only steps", () => {
  it("expenses below the (South African) Regulation 23A minimum do not block", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(affordabilityExpenseEvidenceNeedsMleJustification(belowMle)).toBe(false)
  })

  it("never offers a Section 129 notice, however far in arrears", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const verdict = evaluateCollectionsEligibility(loan, "SECTION_129")
    expect(verdict.eligible).toBe(false)
    expect(verdict.temporary).toBe(false)
    expect(verdict.reason).toMatch(/National Credit Act/)
  })

  it("ordinary dunning is unaffected", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(evaluateCollectionsEligibility(loan, "DUNNING")).toMatchObject({ eligible: true })
  })

  it("approval is not held to the NCA rate cap and reads nothing", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    await expect(approvalInterestCapCheck(noDb, "t1", application)).resolves.toEqual({ ok: true })
  })

  it("the payout re-check of the repeat short-term rule passes and reads nothing", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    await expect(checkRepeatShortTermFor(noDb, "t1", application, new Date())).resolves.toEqual({ ok: true })
  })

  it("a product priced above the NCA cap is accepted on create and on repricing", async () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(await loanProductCreateCapRefusal("t1", product)).toBeNull()
    expect(await loanProductUpdateCapRefusal("t1", { ...product, active: true, interestRatePm: 0.01 }, product)).toBeNull()
  })

  it("the product form does not warn about an NCA cap", () => {
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    expect(interestGuidance(preview)).toMatchObject({ warning: false, classification: null })
  })
})
