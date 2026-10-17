import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { DRAFT_WATERMARK } from "../pdf-layout"
import { renderSurrenderFinalNotice, renderSurrenderValuationNotice, type SurrenderNoticeData } from "./surrender-pdf"

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (hex: string) => [...Buffer.from(hex, "hex")].map((b) => b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b)).join("")
const texts = async (bytes: Buffer) => (await pdfPageContents(bytes)).flatMap((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => winAnsi(m[1])))
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
const costs = [
  { type: "TOWING", label: "Towing and transport", grossCents: 5_000, treatment: "DEDUCT_FROM_PROCEEDS" as const },
  { type: "LEGAL_TAXED", label: "Legal costs (taxed)", grossCents: 2_000, treatment: "CHARGE_TO_ACCOUNT" as const },
]

// The renders of the notices with the drafted clause wording
// (docs/asset-finance/legal-wording/nca.md). Each re-pin has a text-run proof
// in docs/asset-finance/evidence/legal-wording/nca/s127-text-runs/ (1-to-2.diff:
// the placeholder replaced; 2-to-3.diff: the review fixes, which add only the
// valuation notice's clause 1.6 and the shortfall freeze 1.3 on every final
// notice). A surrender with no recovery costs must keep printing these bytes.
const PINNED = {
  valuation: "14e18b5289de8f347cb69739e0b7585740218407a7c70223d154a4e171c32a6a",
  final: "dafdda483a14fef90fa0851dddbb40705d687fff2d304033837a663a1d0c61e4",
  finalWithCosts: "90e34ac52bb974f069c930fda62f9878779510b3edffe90bc754659e3a4e495b",
  // The same notice with the linked recovery's sale and account lines added.
  finalWithRecovery: "aef7544437b1bca34d613f78c19eacb624763cf3400c96ae771a52f31258a9cd",
  // With a charged cost the account cannot carry (R 100.00 of the R 370.00 shortfall): the new line, and the shortfall net of it.
  finalWithUnrecoverable: "b6edeb7f31876d98c8369843f7768ed4165b5484d89d19d610ef713c061b53a6",
}
const recoveryOutcome = {
  settlementDueCents: 150_000, grossProceedsCents: 120_000, deductedCostsCents: 5_000, netProceedsCents: 115_000,
  chargedCostsCents: 2_000, shortfallCents: 37_000, surplusCents: 0,
}

describe("s127 final notice recovery costs", () => {
  it("renders the notices without costs byte-identically to the pinned wording render", async () => {
    expect(sha(await renderSurrenderValuationNotice(data))).toBe(PINNED.valuation)
    expect(sha(await renderSurrenderFinalNotice(data))).toBe(PINNED.final)
    expect(sha(await renderSurrenderFinalNotice({ ...data, costs: [] }))).toBe(PINNED.final)
  })

  it("pins the render with costs (the table and its draft note)", async () => {
    expect(sha(await renderSurrenderFinalNotice({ ...data, costs }))).toBe(PINNED.finalWithCosts)
  })

  it("adds a RECOVERY COSTS section, marked for legal approval, only when costs exist", async () => {
    const withCosts = await texts(await renderSurrenderFinalNotice({ ...data, costs }))
    expect(withCosts).toEqual(expect.arrayContaining(["RECOVERY COSTS", "Towing and transport", "Legal costs (taxed)", "R 50.00", "R 20.00", "Cost lines: DRAFT — require lender legal approval", DRAFT_WATERMARK]))
    const without = await texts(await renderSurrenderFinalNotice(data))
    expect(without).not.toContain("RECOVERY COSTS")
    expect(withCosts).toEqual(expect.arrayContaining(without.filter((line) => !line.startsWith("Page "))))
  })

  it("adds the linked recovery's sale and account lines after the existing ones, marked draft, and nothing else moves", async () => {
    const before = await renderSurrenderFinalNotice({ ...data, costs })
    const after = await renderSurrenderFinalNotice({ ...data, costs, recoveryOutcome })
    expect(sha(before)).toBe(PINNED.finalWithCosts) // before: the render without the recovery lines
    expect(sha(after)).not.toBe(sha(before))
    expect(sha(after)).toBe(PINNED.finalWithRecovery) // after
    const printed = await texts(after)
    const existing = ["Valuation", "Sale proceeds credited", "Shortfall", "Refund due"]
    const added = ["Settlement due at sale", "Gross sale price", "Costs deducted from proceeds", "Net proceeds", "Costs charged to account", "Account shortfall", "Account surplus"]
    for (const label of added) expect(printed.indexOf(label)).toBeGreaterThan(printed.lastIndexOf("Refund due"))
    for (const label of existing) expect(printed).toContain(label)
    expect(printed).toEqual(expect.arrayContaining(["R 1,500.00", "R 1,200.00", "R 1,150.00", "R 370.00", "Sale and account lines: DRAFT — require lender legal approval"]))
    // Without a recovery the notice is the pinned one.
    expect(sha(await renderSurrenderFinalNotice({ ...data, recoveryOutcome: undefined }))).toBe(PINNED.final)
  })

  it("shows charged costs the account cannot carry on a line of their own, with the account shortfall net of them", async () => {
    const withLine = await renderSurrenderFinalNotice({ ...data, costs, recoveryOutcome: { ...recoveryOutcome, unrecoverableCostsCents: 10_000 } })
    const printed = await texts(withLine)
    expect(printed).toContain("Charged costs not recoverable on the account")
    expect(printed).toContain("R 100.00")
    expect(printed).toContain("R 270.00") // R 370.00 shortfall less R 100.00
    expect(printed).not.toContain("R 370.00")
    expect(sha(withLine)).toBe(PINNED.finalWithUnrecoverable)
    // Nil (or none) prints no extra line and leaves the earlier pin alone.
    for (const unrecoverableCostsCents of [0, undefined]) {
      const same = await renderSurrenderFinalNotice({ ...data, costs, recoveryOutcome: { ...recoveryOutcome, unrecoverableCostsCents } })
      expect(sha(same)).toBe(PINNED.finalWithRecovery)
    }
  })
})
