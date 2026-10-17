import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { DRAFT_WATERMARK, PLACEHOLDER_CLAUSE } from "../pdf-layout"
import { renderPostSaleStatement } from "../post-sale-statement"
import { expectDraftMarks, expectWordedClauses, prose, texts } from "./nca-wording.test-helpers"
import { COST_LINES_NOTE, renderRecoveryFinalNotice, renderRecoveryValuationNotice, type RecoveryNoticeData } from "./recovery-pdf"

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

const data: RecoveryNoticeData = {
  legalWordingApproved: false,
  reference: "AF-NCA-S131-TEST", documentDate: new Date("2026-10-15T08:00:00.000Z"),
  lender: { legalName: "TEST Credit Provider", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] },
  borrower: { name: "TEST Borrower", identityNumber: "0000000000000", addressLines: ["2 Synthetic Street", "Testville", "Free State", "9999"] },
  asset: { description: "2026 TEST TLB", serialNumber: "TEST-SERIAL-131", condition: "Synthetic working condition" },
  recoveredOn: "2026-10-10", location: "TEST Yard",
  valuation: { valuedOn: "2026-10-12", valuerName: "TEST Valuer", amountCents: 125_000 },
  outcome: { settlementDueCents: 150_000, grossProceedsCents: 120_000, deductedCostsCents: 5_000, chargedCostsCents: 2_000, netProceedsCents: 115_000, shortfallCents: 37_000, surplusCents: 0 },
  costs: [
    { label: "Towing and transport", grossCents: 5_000, treatment: "DEDUCT_FROM_PROCEEDS" },
    { label: "Legal costs (taxed)", grossCents: 2_000, treatment: "CHARGE_TO_ACCOUNT" },
  ],
}

describe("s131 DRAFT notices", () => {
  it("titles the valuation notice and keeps it deterministic and visibly draft", async () => {
    const first = await renderRecoveryValuationNotice(data)
    expect(sha(first)).toBe(sha(await renderRecoveryValuationNotice({ ...data })))
    const all = await texts(first)
    expect(all.join(" ")).toContain("REPOSSESSED GOODS VALUATION NOTICE")
    expectDraftMarks(all, false)
    expect(all).toContain("R 1,250.00")
  })

  it.each([renderRecoveryValuationNotice, renderRecoveryFinalNotice])("drops the watermark, subtitle and cost note once the wording is approved", async (render) => {
    expectDraftMarks(await texts(await render({ ...data, legalWordingApproved: true })), true)
  })

  it("prints the consumer's address on one line with real separators, not '?'", async () => {
    for (const render of [renderRecoveryValuationNotice, renderRecoveryFinalNotice, renderPostSaleStatement]) {
      const all = await texts(await render(data))
      expect(all).toContain("2 Synthetic Street, Testville, Free State, 9999")
      expect(all.join(" ")).not.toContain("?")
    }
  })

  it("marks the cost lines as draft in a note of their own, not as a label and value", async () => {
    const all = await texts(await renderRecoveryFinalNotice(data))
    expect(all).toContain(COST_LINES_NOTE)
    expect(all).not.toContain("Cost lines")
  })

  it("prints the final account to the cent with its cost table", async () => {
    const all = await texts(await renderRecoveryFinalNotice(data))
    expect(all.join(" ")).toContain("REPOSSESSED GOODS FINAL ACCOUNT NOTICE")
    expect(all).toContain(DRAFT_WATERMARK)
    expect(all).toEqual(expect.arrayContaining(["R 1,200.00", "R 50.00", "R 1,150.00", "R 20.00", "R 370.00", "R 0.00", "RECOVERY COSTS", "Legal costs (taxed)"]))
  })

  it("refuses a notice without its evidence", async () => {
    await expect(renderRecoveryValuationNotice({ ...data, valuation: undefined })).rejects.toThrow(RangeError)
    await expect(renderRecoveryFinalNotice({ ...data, outcome: undefined })).rejects.toThrow(RangeError)
  })
})

describe("charged costs the account cannot carry", () => {
  const withUnrecoverable: RecoveryNoticeData = { ...data, outcome: { ...data.outcome!, unrecoverableCostsCents: 10_000 } }

  it("print on their own line and the shortfall is net of them, in the s131 notice and the NON_NCA statement", async () => {
    for (const render of [renderRecoveryFinalNotice, renderPostSaleStatement]) {
      const all = await texts(await render(withUnrecoverable))
      expect(all).toContain("Charged costs not recoverable on the account")
      expect(all).toContain("R 100.00")
      expect(all).toContain("R 270.00") // R 370.00 less R 100.00
      expect(all).not.toContain("R 370.00")
    }
  })

  it("print nothing extra when there are none", async () => {
    for (const render of [renderRecoveryFinalNotice, renderPostSaleStatement]) {
      const all = await texts(await render({ ...data, outcome: { ...data.outcome!, unrecoverableCostsCents: 0 } }))
      expect(all).not.toContain("Charged costs not recoverable on the account")
      expect(all).toContain("R 370.00")
    }
  })
})

describe("NON_NCA post-sale statement", () => {
  it("is a plain statement: no NCA wording, no placeholder clause, no watermark", async () => {
    const all = await texts(await renderPostSaleStatement(data))
    expect(all.join(" ")).toContain("POST-SALE ACCOUNT STATEMENT")
    expect(all).not.toContain(DRAFT_WATERMARK)
    expect(all).not.toContain(PLACEHOLDER_CLAUSE)
    expect(all.join(" ")).not.toMatch(/NOTICE|NCR/)
    // The NCA notices' consumer-rights wording, which the same data renders, stays out of it.
    expect(prose(await texts(await renderRecoveryFinalNotice(data)))).toContain("section 127")
    expect(all.join(" ")).not.toMatch(/Consumer rights|section 12[789]|National Credit Act/)
    expect(all).toEqual(expect.arrayContaining(["R 1,200.00", "R 370.00", "Towing and transport"]))
  })

  it("needs the applied proceeds", async () => {
    await expect(renderPostSaleStatement({ ...data, outcome: undefined })).rejects.toThrow(RangeError)
  })
})

describe("s131 notice wording", () => {
  it("prints each notice's clause with wording, no placeholder", async () => {
    expectWordedClauses(await texts(await renderRecoveryValuationNotice(data)), ["Consumer rights following repossession and valuation"])
    expectWordedClauses(await texts(await renderRecoveryFinalNotice(data)), ["Consumer rights following sale and account reconciliation"])
  })

  it("the valuation notice names the parties, the place, the dates and the valuation", async () => {
    const all = prose(await texts(await renderRecoveryValuationNotice(data)))
    expect(all).toContain('"you" means TEST Borrower and "we" means TEST Credit Provider, registered credit provider NCRCP00000')
    expect(all).toContain("enforcing agreement AF-NCA-S131-TEST and has been held at TEST Yard since 10 October 2026")
    expect(all).toContain("R 1,250.00, as valued by TEST Valuer on 12 October 2026")
    expect(all).toContain("you may remedy your default by paying all overdue amounts")
    expect(all).toContain("up to the time the default is remedied, as section 129(3) of the Act provides")
    expect(all).toContain("If the sale realises more than what you owe, section 127 of the Act requires us to remit the surplus to you with our notice after the sale.")
    expect(all).toContain("If you do not, we will pay it as soon as you give us those details.")
    expect(all).not.toMatch(/reinstate/i)
  })

  it("the final notice demands the shortfall net of unrecoverable costs, or promises the surplus", async () => {
    const shortfall = prose(await texts(await renderRecoveryFinalNotice(data)))
    expect(shortfall).toContain("we demand payment of the shortfall of R 370.00")
    expect(shortfall).toContain("1.3 No interest, fees or charges accrue on your account from the date the sale proceeds were applied")
    const net = prose(await texts(await renderRecoveryFinalNotice({ ...data, outcome: { ...data.outcome!, unrecoverableCostsCents: 10_000 } })))
    expect(net).toContain("we demand payment of the shortfall of R 270.00")
    const surplus = prose(await texts(await renderRecoveryFinalNotice({ ...data, outcome: { ...data.outcome!, shortfallCents: 0, surplusCents: 8_000 } })))
    expect(surplus).toContain("exceeded what you owe by R 80.00")
    expect(surplus).toContain("we have issued a payment instruction with this notice")
    expect(surplus).toContain("Payment remains outstanding until bank execution is evidenced")
    expect(surplus).not.toMatch(/we demand payment|once we have verified|No interest, fees or charges accrue/)
    expect(surplus).toContain("1.3 The agreement ends")
  })
})
