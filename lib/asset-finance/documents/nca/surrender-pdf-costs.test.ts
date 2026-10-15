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

// The renders of the notices before the cost table existed (sha-256 at the commit that added it).
// A surrender with no recovery costs must keep printing exactly these bytes.
const PINNED = {
  valuation: "edcaedb44f63467ae0ae234aa3762467dfb91deb08effa8fd655cbf8526a3bbb",
  final: "6ccbbe4d0c06fae3b3462b07e4d5171c83d1262a684109ab506223406db0670a",
  finalWithCosts: "9274b32e7ea83f50e78fe66cbbe6384dc6be377716b4fae27c7f30601248b250",
  // The same notice with the linked recovery's sale and account lines added (new, no earlier pin).
  finalWithRecovery: "73bba831e204f3f125377d10e9c780768e1eb19388193d3af3811097aa6bc297",
}
const recoveryOutcome = {
  settlementDueCents: 150_000, grossProceedsCents: 120_000, deductedCostsCents: 5_000, netProceedsCents: 115_000,
  chargedCostsCents: 2_000, shortfallCents: 37_000, surplusCents: 0,
}

describe("s127 final notice recovery costs", () => {
  it("renders the notices without costs byte-identically to before the table existed", async () => {
    expect(sha(await renderSurrenderValuationNotice(data))).toBe(PINNED.valuation)
    expect(sha(await renderSurrenderFinalNotice(data))).toBe(PINNED.final)
    expect(sha(await renderSurrenderFinalNotice({ ...data, costs: [] }))).toBe(PINNED.final)
  })

  it("pins the render with costs (the table and its draft note are new, with no earlier pin)", async () => {
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
})
