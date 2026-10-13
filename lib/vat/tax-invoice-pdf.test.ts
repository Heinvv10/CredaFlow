import { createHash } from "node:crypto"
import { PDFDocument } from "pdf-lib"
import { describe, expect, it } from "vitest"
import { extractPdfTextRunsByPage } from "@/lib/pdf/__tests__/pdf-test-utils"
import { generateTaxInvoicePdf, type TaxInvoicePdfInput, type TaxInvoicePdfLine } from "./tax-invoice-pdf"

const line = (lineNo: number, description: string, exclVatCents: number, vatCents: number): TaxInvoicePdfLine => ({
  lineNo, description, quantity: 1, unitExclVatCents: exclVatCents, exclVatCents, vatCents, inclVatCents: exclVatCents + vatCents,
})

const INVOICE: TaxInvoicePdfInput = {
  invoiceNumber: "INV-000042",
  issueDate: new Date("2026-10-13T00:00:00.000Z"),
  supplyDate: new Date("2026-10-12T00:00:00.000Z"),
  createdAt: new Date("2026-10-13T08:00:00.000Z"),
  supplierName: "Test Lender (Pty) Ltd",
  supplierAddress: "1 Test Street, Testville, 0001",
  supplierVatNumber: "4000000000",
  recipientName: "Test Borrower (Pty) Ltd",
  recipientAddress: "2 Test Road, Testville, 0002",
  recipientVatNumber: "4111111111",
  vatRate: "0.1500",
  totalExclVatCents: 1_000_000_00,
  vatCents: 150_000_00,
  totalInclVatCents: 1_150_000_00,
  lines: [line(1, "2026 Testmake TX 200, serial no. TESTSERIAL0001, VIN TEST0000000000001", 1_000_000_00, 150_000_00)],
}

async function texts(bytes: Buffer): Promise<string[][]> {
  return (await extractPdfTextRunsByPage(bytes)).map((runs) => runs.map((run) => run.text))
}

describe("generateTaxInvoicePdf", () => {
  it("prints the s20(4) content on one A4 page", async () => {
    const bytes = await generateTaxInvoicePdf(INVOICE)
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
    expect(doc.getPage(0).getSize()).toEqual({ width: 595.28, height: 841.89 })
    const [page] = await texts(bytes)
    expect(page).toEqual(expect.arrayContaining([
      "TAX INVOICE",
      "INV-000042", "13 October 2026", "12 October 2026",
      "Test Lender (Pty) Ltd", "1 Test Street, Testville, 0001", "4000000000",
      "Test Borrower (Pty) Ltd", "2 Test Road, Testville, 0002", "4111111111",
      "Qty", "1",
      "R 1,000,000.00", "R 150,000.00", "R 1,150,000.00",
      "Value of supply (excl. VAT)", "VAT charged at 15%", "Total consideration (incl. VAT)",
      "Page 1 of 1",
    ]))
    expect(page.join(" ")).toContain("2026 Testmake TX 200, serial no. TESTSERIAL0001, VIN")
    expect(page.join(" ")).toContain("TEST0000000000001")
  })

  it("omits the recipient VAT number line for an unregistered recipient", async () => {
    const [page] = await texts(await generateTaxInvoicePdf({ ...INVOICE, recipientVatNumber: null }))
    expect(page.filter((t) => t === "VAT Reg No:")).toHaveLength(1)
    expect(page).not.toContain("4111111111")
  })

  it("is byte-identical when the same invoice is rendered again", async () => {
    const hash = async () => createHash("sha256").update(await generateTaxInvoicePdf(INVOICE)).digest("hex")
    expect(await hash()).toBe(await hash())
  })

  it("continues a long table onto further pages with its headers, losing no line", async () => {
    const lines = Array.from({ length: 60 }, (_, i) => line(i + 1, `Test item ${i + 1}`, 100, 15))
    const bytes = await generateTaxInvoicePdf({ ...INVOICE, lines, totalExclVatCents: 6000, vatCents: 900, totalInclVatCents: 6900 })
    const pages = await texts(bytes)
    expect(pages.length).toBeGreaterThan(1)
    for (const page of pages) if (page.some((t) => t.startsWith("Test item"))) expect(page).toContain("Description")
    const items = pages.flat().filter((t) => t.startsWith("Test item"))
    expect(items).toEqual(lines.map((l) => l.description))
    const last = pages[pages.length - 1]
    expect(last).toEqual(expect.arrayContaining(["R 60.00", "R 9.00", "R 69.00", `Page ${pages.length} of ${pages.length}`]))
  })

  it("splits one long wrapped description before any text leaves the page", async () => {
    const descriptionLines = Array.from({ length: 80 }, (_, i) => `Description line ${i + 1}`)
    const bytes = await generateTaxInvoicePdf({
      ...INVOICE,
      lines: [line(1, descriptionLines.join("\n"), 100, 15)],
      totalExclVatCents: 100,
      vatCents: 15,
      totalInclVatCents: 115,
    })
    const pages = await extractPdfTextRunsByPage(bytes)
    const descriptions = pages.flat().filter((run) => run.text.startsWith("Description line"))

    expect(descriptions.map((run) => run.text)).toEqual(descriptionLines)
    expect(descriptions.every((run) => run.y >= 90)).toBe(true)
    for (const page of pages) if (page.some((run) => run.text.startsWith("Description line"))) {
      expect(page.some((run) => run.text === "Description")).toBe(true)
    }
  })
})
