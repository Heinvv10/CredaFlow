import { describe, expect, it, vi } from "vitest"
import {
  VatNotConfiguredError, computeTaxInvoice, describeAsset, issueInstalmentSaleInvoice, issueTaxInvoice,
  type TaxInvoiceDb,
} from "./tax-invoice"

describe("computeTaxInvoice", () => {
  it("extends each line, computes VAT per line half-up, and totals the lines", () => {
    const invoice = computeTaxInvoice([
      { description: "Test widget", quantity: 3, unitExclVatCents: 333 }, // 999; VAT 149.85 → 150
      { description: "Test service fee", quantity: 1, unitExclVatCents: 10 }, // 10; VAT 1.50 → 2
    ], 1500)
    expect(invoice.lines.map((l) => [l.lineNo, l.exclVatCents, l.vatCents, l.inclVatCents])).toEqual([
      [1, 999, 150, 1149],
      [2, 10, 2, 12],
    ])
    // The sum of per-line VAT (152), not VAT on the total value (1009 → 151.35 → 151).
    expect(invoice).toMatchObject({ totalExclVatCents: 1009, vatCents: 152, totalInclVatCents: 1161 })
  })

  it("refuses no lines, a non-positive quantity or price, and a blank description", () => {
    expect(() => computeTaxInvoice([], 1500)).toThrow(/at least one line/)
    expect(() => computeTaxInvoice([{ description: "x", quantity: 0, unitExclVatCents: 1 }], 1500)).toThrow(/quantity/)
    expect(() => computeTaxInvoice([{ description: "x", quantity: 1, unitExclVatCents: 0 }], 1500)).toThrow(/unitExclVatCents/)
    expect(() => computeTaxInvoice([{ description: "x", quantity: 1, unitExclVatCents: 1.5 }], 1500)).toThrow(/unitExclVatCents/)
    expect(() => computeTaxInvoice([{ description: "  ", quantity: 1, unitExclVatCents: 1 }], 1500)).toThrow(/description/)
  })
})

const CONFIG = { id: "vc1", tenantId: "t1", vatNumber: "4000000000", registeredName: "Test Lender (Pty) Ltd", address: "1 Test Street, Testville", updatedAt: new Date(0) }

function fakeDb(config: typeof CONFIG | null) {
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => args.data)
  const db = {
    vatConfig: { findUnique: vi.fn(async () => config) },
    vatRate: { findFirst: vi.fn(async () => ({ id: "r", effectiveDate: new Date("2018-04-01T00:00:00Z"), rate: "0.1500" })) },
    taxInvoice: { create },
  }
  return { db: db as unknown as TaxInvoiceDb, create }
}

const BOOKING = {
  tenantId: "t1",
  loanId: "loan1",
  bookingDate: "2026-10-13",
  recipient: { name: "Test Borrower (Pty) Ltd", address: "2 Test Road, Testville", vatNumber: "4111111111" },
  asset: { make: "Testmake", model: "TX 200", year: 2026, serialNumber: "TESTSERIAL0001", vin: "TEST0000000000001" },
  cashPriceExclVatCents: 1_000_000_00,
  createdById: "user1",
}

describe("issueInstalmentSaleInvoice", () => {
  it("issues exactly one line, the asset at its cash price ex VAT, with no interest line", async () => {
    const { db, create } = fakeDb(CONFIG)
    await issueInstalmentSaleInvoice(db, BOOKING)
    expect(create).toHaveBeenCalledTimes(1)
    const data = create.mock.calls[0][0].data as {
      lines: { create: Array<Record<string, unknown>> }
    } & Record<string, unknown>
    expect(data.lines.create).toEqual([{
      lineNo: 1,
      description: "2026 Testmake TX 200, serial no. TESTSERIAL0001, VIN TEST0000000000001",
      quantity: 1,
      unitExclVatCents: 1_000_000_00,
      exclVatCents: 1_000_000_00,
      vatCents: 150_000_00,
      inclVatCents: 1_150_000_00,
    }])
    expect(JSON.stringify(data.lines.create)).not.toMatch(/interest|finance charge/i)
    expect(data).toMatchObject({
      tenantId: "t1",
      loanId: "loan1",
      issueDate: new Date("2026-10-13T00:00:00.000Z"),
      supplyDate: new Date("2026-10-13T00:00:00.000Z"),
      supplierName: CONFIG.registeredName,
      supplierAddress: CONFIG.address,
      supplierVatNumber: CONFIG.vatNumber,
      recipientName: BOOKING.recipient.name,
      recipientVatNumber: "4111111111",
      vatRate: "0.1500",
      totalExclVatCents: 1_000_000_00,
      vatCents: 150_000_00,
      totalInclVatCents: 1_150_000_00,
      createdById: "user1",
    })
  })

  it("refuses a tenant with no VAT configuration, before writing anything", async () => {
    const { db, create } = fakeDb(null)
    await expect(issueInstalmentSaleInvoice(db, BOOKING)).rejects.toBeInstanceOf(VatNotConfiguredError)
    expect(create).not.toHaveBeenCalled()
  })

  it("stores no recipient VAT number for an unregistered recipient", async () => {
    const { db, create } = fakeDb(CONFIG)
    await issueTaxInvoice(db, {
      tenantId: "t1", issueDate: "2026-10-13", supplyDate: "2026-10-13",
      recipient: { name: "Test Person", address: "3 Test Lane", vatNumber: " " },
      lines: [{ description: "Test fee", quantity: 1, unitExclVatCents: 100 }],
    })
    expect(create.mock.calls[0][0].data).toMatchObject({ recipientVatNumber: null, loanId: null })
  })
})

describe("describeAsset", () => {
  it("needs a serial number or a VIN", () => {
    expect(() => describeAsset({ make: "Testmake", model: "TX", year: 2026 })).toThrow(/serial number or a VIN/)
    expect(describeAsset({ make: "Testmake", model: "Digger 9", year: 2025, serialNumber: "TESTSERIAL0002" }))
      .toBe("2025 Testmake Digger 9, serial no. TESTSERIAL0002")
  })
})
