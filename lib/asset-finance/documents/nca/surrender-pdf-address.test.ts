import { describe, expect, it } from "vitest"
import { pdfPageContents } from "@/lib/pdf/__tests__/pdf-test-utils"
import { renderNcaAssetAgreement } from "./agreement-pdf"
import { renderNcaAssetQuote } from "./quote-pdf"
import { renderSurrenderFinalNotice, renderSurrenderValuationNotice, type SurrenderNoticeData } from "./surrender-pdf"
import type { NcaAssetDocumentData } from "./types"

const CP1252_HIGH = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ"
const winAnsi = (hex: string) => [...Buffer.from(hex, "hex")].map((b) => b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : String.fromCharCode(b)).join("")
const texts = async (bytes: Buffer) => (await pdfPageContents(bytes)).flatMap((content) => [...content.matchAll(/<([0-9A-Fa-f]+)> Tj/g)].map((m) => winAnsi(m[1])))

const ADDRESS = ["2 Synthetic Street", "Testville", "Free State", "9999"]

const surrender: SurrenderNoticeData = {
  legalWordingApproved: false,
  reference: "AF-NCA-S127-TEST", documentDate: new Date("2026-10-13T08:00:00.000Z"),
  lender: { legalName: "TEST Credit Provider", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] },
  borrower: { name: "TEST Borrower", identityNumber: "0000000000000", addressLines: ADDRESS },
  asset: { description: "2026 TEST TLB", serialNumber: "TEST-SERIAL-127", condition: "Synthetic working condition" },
  requestDate: "2026-10-13", valuationDueDate: "2026-10-27",
  valuation: { valuedOn: "2026-10-20", valuerName: "TEST Valuer", amountCents: 125_000 },
  outcome: { saleProceedsCents: 100_000, shortfallCents: 25_000, refundCents: 0 },
}

const deal: NcaAssetDocumentData = {
  legalWordingApproved: false,
  reference: "AF-NCA-TEST-1", documentDate: new Date("2026-10-13T08:00:00.000Z"), contractType: "FINANCE_LEASE",
  lender: { legalName: "TEST Credit Provider (Pty) Ltd", ncrNumber: "NCRCP00000", registeredOfficeLines: ["1 Test Road"] },
  borrower: { name: "TEST Sole Proprietor", identityNumber: "0000000000000", addressLines: ADDRESS },
  asset: { description: "TEST 2026 TLB", serialNumber: "TESTSERIAL0001" },
  pricing: {
    cashPriceCents: 1_725_000, depositCents: 225_000, principalCents: 1_500_000, annualRate: "0.1175",
    rateBasis: "FIXED", rateMargin: null, reference: null,
    initiationFeeCents: 120_750, monthlyServiceFeeCents: 6_000, creditLifePremiumCents: 7_500,
    instalmentCents: 140_000, balloonCents: 300_000, totalInterestCents: 172_500,
    totalCostOfCreditCents: 373_250, totalRepayableCents: 1_873_250,
  },
  schedule: [{ installmentNo: 1, dueDate: "2026-11-30", principalCents: 100_000, interestCents: 14_000, feesCents: 13_500, totalCents: 127_500, closingBalanceCents: 1_400_000 }],
}

/** The printed lines from the address label up to the next label. */
async function addressBlock(bytes: Buffer, label: string, next: string): Promise<string[]> {
  const printed = await texts(bytes)
  const start = printed.indexOf(label)
  expect(start).toBeGreaterThanOrEqual(0)
  return printed.slice(start + 1, printed.indexOf(next, start))
}

describe("a multi-line address prints one line per address line", () => {
  it.each([
    ["s127 valuation notice", () => renderSurrenderValuationNotice(surrender)],
    ["s127 final notice", () => renderSurrenderFinalNotice(surrender)],
  ])("%s", async (_name, render) => {
    const block = await addressBlock(await render(), "Consumer address", "Asset")
    expect(block).toEqual(ADDRESS)
    expect(block.join("")).not.toContain("?")
  })

  it.each([
    ["NCA asset quote", () => renderNcaAssetQuote(deal), "Consumer address", "COST OF CREDIT DISCLOSURE"],
    ["NCA asset agreement", () => renderNcaAssetAgreement(deal), "Address", "Asset"],
  ])("%s", async (_name, render, label, next) => {
    expect(await addressBlock(await render(), label, next)).toEqual(ADDRESS)
  })
})
