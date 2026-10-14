import { createHash } from "node:crypto"
import { describe, expect, it } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { DRAFT_WATERMARK, PLACEHOLDER_CLAUSE } from "../pdf-layout"
import { renderNcaAssetAgreement } from "./agreement-pdf"
import { renderNcaAssetQuote } from "./quote-pdf"
import type { NcaAssetDocumentData } from "./types"

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (hex: string) => [...Buffer.from(hex, "hex")].map((b) => b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b)).join("")
const texts = async (bytes: Buffer) => (await pdfPageContents(bytes)).flatMap((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => winAnsi(m[1])))
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex")

const data: NcaAssetDocumentData = {
  reference: "AF-NCA-TEST-1", documentDate: new Date("2026-10-13T08:00:00.000Z"), contractType: "FINANCE_LEASE",
  lender: { legalName: "TEST Credit Provider (Pty) Ltd", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road", "Johannesburg"] },
  borrower: { name: "TEST Sole Proprietor", identityNumber: "0000000000000", addressLines: ["2 Synthetic Street", "Johannesburg"] },
  asset: { description: "TEST 2026 TLB", serialNumber: "TESTSERIAL0001" },
  pricing: {
    cashPriceCents: 1_725_000, depositCents: 225_000, principalCents: 1_500_000, annualRate: "0.1175",
    initiationFeeCents: 120_750, monthlyServiceFeeCents: 6_000, creditLifePremiumCents: 7_500,
    instalmentCents: 140_000, balloonCents: 300_000, totalInterestCents: 172_500,
    totalCostOfCreditCents: 373_250, totalRepayableCents: 1_873_250,
  },
  schedule: [{ installmentNo: 1, dueDate: "2026-11-30", principalCents: 100_000, interestCents: 14_000, feesCents: 13_500, totalCents: 127_500, closingBalanceCents: 1_400_000 }],
}

describe("asset-finance NCA documents", () => {
  it.each([renderNcaAssetQuote, renderNcaAssetAgreement])("is deterministic, watermarked and placeholder-only", async (render) => {
    const first = await render(data)
    expect(sha(first)).toBe(sha(await render({ ...data })))
    const all = await texts(first)
    expect(all).toContain(DRAFT_WATERMARK)
    expect(all).toContain(PLACEHOLDER_CLAUSE)
    expect(all).toEqual(expect.arrayContaining(["TEST Sole Proprietor", "R 15,000.00", "R 18,732.50"]))
    expect(all.join(" ")).toContain("TESTSERIAL0001")
  })

  it("renders agreement-specific titles with the same real figures", async () => {
    expect(await texts(await renderNcaAssetAgreement(data))).toContain("NCA FINANCE LEASE AGREEMENT")
    expect(await texts(await renderNcaAssetAgreement({ ...data, contractType: "INSTALMENT_SALE" }))).toContain("NCA INSTALMENT SALE AGREEMENT")
  })
})
