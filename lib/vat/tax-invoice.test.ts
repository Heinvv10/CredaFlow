import { describe, expect, it, vi } from "vitest"
import { vatOnExclusive } from "./amounts"
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

function fakeDb(config: typeof CONFIG | null, stored: (data: Record<string, unknown>) => Record<string, unknown> = (data) => data) {
  const calls: string[] = []
  const create = vi.fn(async (args: { data: Record<string, unknown> }) => {
    calls.push("create")
    return stored(args.data)
  })
  const executeRaw = vi.fn(async (sql: string) => {
    calls.push(sql)
    return 0
  })
  const db = {
    vatConfig: { findUnique: vi.fn(async () => config) },
    vatRate: { findFirst: vi.fn(async () => ({ id: "r", effectiveDate: new Date("2018-04-01T00:00:00Z"), rate: "0.1500" })) },
    taxInvoice: { create },
    $executeRawUnsafe: executeRaw,
  }
  return { db: db as unknown as TaxInvoiceDb, create, calls }
}

const BOOKING = {
  tenantId: "t1",
  loanId: "loan1",
  bookingDate: "2026-10-13",
  recipient: { name: "Test Borrower (Pty) Ltd", address: "2 Test Road, Testville", vatNumber: "4111111111" },
  asset: { make: "Testmake", model: "TX 200", year: 2026, serialNumber: "TESTSERIAL0001", vin: "TEST0000000000001" },
  cashPriceCents: 1_150_000_00, // VAT-inclusive
  createdById: "user1",
}

describe("issueInstalmentSaleInvoice", () => {
  it("issues exactly one line, the asset at its VAT-inclusive cash price split by the tax fraction, with no interest line", async () => {
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

  it("states exclusive + VAT = the cash price even where no exclusive price adds VAT back to it", async () => {
    // R1 150 000.04: exclusive 1 000 000.03 carries VAT 150 000.00 on the
    // exclusive method, 4 cents short; the tax fraction makes it add up.
    const { db, create } = fakeDb(CONFIG)
    await issueInstalmentSaleInvoice(db, { ...BOOKING, cashPriceCents: 115_000_004 })
    const data = create.mock.calls[0][0].data as { lines: { create: Array<Record<string, number>> } } & Record<string, unknown>
    expect(vatOnExclusive(100_000_003, 1500) + 100_000_003).not.toBe(115_000_004)
    expect(data.lines.create[0]).toMatchObject({ unitExclVatCents: 100_000_003, exclVatCents: 100_000_003, vatCents: 15_000_001, inclVatCents: 115_000_004 })
    expect(data).toMatchObject({ totalExclVatCents: 100_000_003, vatCents: 15_000_001, totalInclVatCents: 115_000_004 })
  })

  it("refuses an issued invoice whose amounts do not add up to the cash price", async () => {
    const { db } = fakeDb(CONFIG, (data) => ({ ...data, invoiceNumber: "INV-000001", vatCents: 150_000_01, totalInclVatCents: 1_150_000_01 }))
    await expect(issueInstalmentSaleInvoice(db, BOOKING)).rejects.toThrow(/does not equal the cash price/)
  })

  it("forces the deferred totals check before returning (Prisma reports a COMMIT-time rollback as success)", async () => {
    const { db, calls } = fakeDb(CONFIG)
    await issueInstalmentSaleInvoice(db, BOOKING)
    expect(calls).toEqual(["create", "SET CONSTRAINTS ALL IMMEDIATE"])
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

describe("computeTaxInvoice on a VAT-inclusive price: excl + VAT == price for every amount 1..200 000 cents", () => {
  it("round-trips exactly, and each line passes the database's VAT rule", () => {
    for (let incl = 1; incl <= 200_000; incl++) {
      const invoice = computeTaxInvoice([{ description: "Test asset", inclVatCents: incl }], 1500)
      const [line] = invoice.lines
      if (line.exclVatCents + line.vatCents !== incl || invoice.totalInclVatCents !== incl || line.unitExclVatCents !== line.exclVatCents) {
        throw new Error(`round trip failed at ${incl}`)
      }
      // checkTaxInvoiceLineVat: VAT on the exclusive value, or the tax-fraction split.
      const exclusiveRule = line.vatCents === vatOnExclusive(line.exclVatCents, 1500)
      const inclusiveRule = line.exclVatCents === Math.floor((2 * incl * 10_000 + 11_500) / 23_000)
      if (!exclusiveRule && !inclusiveRule) throw new Error(`line VAT rule fails at ${incl}`)
    }
  })
})

describe("describeAsset", () => {
  it("needs a serial number or a VIN", () => {
    expect(() => describeAsset({ make: "Testmake", model: "TX", year: 2026 })).toThrow(/serial number or a VIN/)
    expect(describeAsset({ make: "Testmake", model: "Digger 9", year: 2025, serialNumber: "TESTSERIAL0002" }))
      .toBe("2025 Testmake Digger 9, serial no. TESTSERIAL0002")
  })
})
