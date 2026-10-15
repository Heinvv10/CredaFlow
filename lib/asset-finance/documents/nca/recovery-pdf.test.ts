import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { DRAFT_WATERMARK, PLACEHOLDER_CLAUSE } from "../pdf-layout"
import { renderPostSaleStatement } from "../post-sale-statement"
import { renderRecoveryFinalNotice, renderRecoveryValuationNotice, type RecoveryNoticeData } from "./recovery-pdf"

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (hex: string) => [...Buffer.from(hex, "hex")].map((b) => b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b)).join("")
const texts = async (bytes: Buffer) => (await pdfPageContents(bytes)).flatMap((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => winAnsi(m[1])))
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

const data: RecoveryNoticeData = {
  reference: "AF-NCA-S131-TEST", documentDate: new Date("2026-10-15T08:00:00.000Z"),
  lender: { legalName: "TEST Credit Provider", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] },
  borrower: { name: "TEST Borrower", identityNumber: "0000000000000", addressLines: ["2 Synthetic Street"] },
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
    expect(all).toContain(DRAFT_WATERMARK)
    expect(all).toContain(PLACEHOLDER_CLAUSE)
    expect(all).toContain("R 1,250.00")
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

describe("NON_NCA post-sale statement", () => {
  it("is a plain statement: no NCA wording, no placeholder clause, no watermark", async () => {
    const all = await texts(await renderPostSaleStatement(data))
    expect(all.join(" ")).toContain("POST-SALE ACCOUNT STATEMENT")
    expect(all).not.toContain(DRAFT_WATERMARK)
    expect(all).not.toContain(PLACEHOLDER_CLAUSE)
    expect(all.join(" ")).not.toMatch(/NOTICE|NCR/)
    expect(all).toEqual(expect.arrayContaining(["R 1,200.00", "R 370.00", "Towing and transport"]))
  })

  it("needs the applied proceeds", async () => {
    await expect(renderPostSaleStatement({ ...data, outcome: undefined })).rejects.toThrow(RangeError)
  })
})
