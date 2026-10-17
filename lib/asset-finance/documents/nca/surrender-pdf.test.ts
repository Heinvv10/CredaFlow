import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { expectDraftMarks, expectWordedClauses, prose, texts } from "./nca-wording.test-helpers"
import { renderSurrenderFinalNotice, renderSurrenderValuationNotice, type SurrenderNoticeData } from "./surrender-pdf"

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

const data: SurrenderNoticeData = {
  legalWordingApproved: false,
  reference: "AF-NCA-S127-TEST", documentDate: new Date("2026-10-13T08:00:00.000Z"),
  lender: { legalName: "TEST Credit Provider", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] },
  borrower: { name: "TEST Borrower", identityNumber: "0000000000000", addressLines: ["2 Synthetic Street"] },
  asset: { description: "2026 TEST TLB", serialNumber: "TEST-SERIAL-127", condition: "Synthetic working condition" },
  requestDate: "2026-10-13", valuationDueDate: "2026-10-27",
  valuation: { valuedOn: "2026-10-20", valuerName: "TEST Valuer", amountCents: 125_000 },
  outcome: { saleProceedsCents: 100_000, shortfallCents: 25_000, refundCents: 0 },
}
const recoveryOutcome = {
  settlementDueCents: 150_000, grossProceedsCents: 120_000, deductedCostsCents: 5_000, netProceedsCents: 115_000,
  chargedCostsCents: 2_000, shortfallCents: 37_000, surplusCents: 0,
}

describe("s127 notices", () => {
  it.each([renderSurrenderValuationNotice, renderSurrenderFinalNotice])("is deterministic and keeps its DRAFT marks until the wording is approved", async (render) => {
    const first = await render(data)
    expect(sha(first)).toBe(sha(await render({ ...data })))
    const all = await texts(first)
    expectDraftMarks(all, false)
    expect(prose(all)).toContain("TEST-SERIAL-127")
    expectDraftMarks(await texts(await render({ ...data, legalWordingApproved: true })), true)
  })

  it("drops the draft notes on the recovery's sale and cost lines once approved", async () => {
    const costs = [{ type: "TOWING", label: "Towing and transport", grossCents: 5_000, treatment: "DEDUCT_FROM_PROCEEDS" as const }]
    const draft = await texts(await renderSurrenderFinalNotice({ ...data, costs, recoveryOutcome }))
    expect(draft).toEqual(expect.arrayContaining(["Sale and account lines: DRAFT — require lender legal approval", "Cost lines: DRAFT — require lender legal approval"]))
    expectDraftMarks(await texts(await renderSurrenderFinalNotice({ ...data, costs, recoveryOutcome, legalWordingApproved: true })), true)
  })

  it("prints the sale result to the cent", async () => {
    const all = await texts(await renderSurrenderFinalNotice(data))
    expect(all).toEqual(expect.arrayContaining(["R 1,000.00", "R 250.00", "R 0.00"]))
  })
})

describe("s127 notice wording", () => {
  it("prints each notice's clause with wording, no placeholder", async () => {
    expectWordedClauses(await texts(await renderSurrenderValuationNotice(data)), ["Consumer rights following valuation"])
    expectWordedClauses(await texts(await renderSurrenderFinalNotice(data)), ["Consumer rights following disposal and account reconciliation"])
  })

  it("the valuation notice names the parties, the dates, the valuation and the withdrawal right", async () => {
    const all = prose(await texts(await renderSurrenderValuationNotice(data)))
    expect(all).toContain('"you" means TEST Borrower and "we" means TEST Credit Provider, registered credit provider NCRCP00000')
    expect(all).toContain("On 13 October 2026 you gave notice under section 127(1)")
    expect(all).toContain("terminate agreement AF-NCA-S127-TEST")
    expect(all).toContain("the estimated value of the asset is R 1,250.00, as valued by TEST Valuer on 20 October 2026")
    expect(all).toContain("unconditionally withdraw your termination notice")
  })

  it("the final notice demands the shortfall, or promises the surplus, from the deal's figures", async () => {
    const shortfall = prose(await texts(await renderSurrenderFinalNotice(data)))
    expect(shortfall).toContain("we demand payment of the shortfall of R 250.00")
    expect(shortfall).not.toContain("No interest, fees or charges accrue") // no recovery, no charge freeze
    const linked = prose(await texts(await renderSurrenderFinalNotice({ ...data, recoveryOutcome: { ...recoveryOutcome, unrecoverableCostsCents: 10_000 } })))
    expect(linked).toContain("we demand payment of the shortfall of R 270.00")
    expect(linked).toContain("No interest, fees or charges accrue on your account")
    const surplus = prose(await texts(await renderSurrenderFinalNotice({ ...data, outcome: { saleProceedsCents: 150_000, shortfallCents: 0, refundCents: 25_000 } })))
    expect(surplus).toContain("exceeded the settlement value by R 250.00")
    expect(surplus).not.toContain("we demand payment")
    const even = prose(await texts(await renderSurrenderFinalNotice({ ...data, outcome: { saleProceedsCents: 125_000, shortfallCents: 0, refundCents: 0 } })))
    expect(even).toContain("Nothing further is owed by you or by us")
  })
})
