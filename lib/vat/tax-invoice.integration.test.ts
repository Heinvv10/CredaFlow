/**
 * Real-DB proof of the tax-document rules in migration 20261013100000:
 * immutability, gap-free numbering under concurrency (max + 1 under an
 * advisory lock), a supplied number ignored, totals = lines at commit, the
 * credit-note cap, the VatRate seed, a line's and a credit note's VAT
 * consistent with the invoice rate, and the deferred checks surfacing inside
 * issueTaxInvoice / issueCreditNote. The VatRate rules are in
 * ./vat-rate.integration.test.ts.
 *
 *   RUN_VAT_INVOICE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/vat/tax-invoice.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { issueCreditNote, type CreditNoteDb } from "./credit-note"
import { VatNotConfiguredError, issueTaxInvoice, type IssueTaxInvoiceInput, type TaxInvoiceDb } from "./tax-invoice"
import { NoVatRateError, loadRateOn } from "./vat-rate"

const suite = process.env.RUN_VAT_INVOICE_IT === "1" ? describe : describe.skip

// The functions take the app's tenant-scoped transaction type; an extended
// client with no query hooks has the same shape and none of the scoping.
const newClient = () => new PrismaClient().$extends({ name: "vat-it", query: {} })
type Client = ReturnType<typeof newClient>

const IMMUTABLE = /immutable once issued/
const TOTALS = /totals must equal the sum of its lines/

suite("tax invoices and credit notes (real DB)", () => {
  const tag = randomUUID().replaceAll("-", "").slice(0, 12)
  const db = newClient()
  const clients: Client[] = []
  const tenantIds: string[] = []
  let tenantId = ""
  let raceTenantId = ""
  let bareTenantId = ""

  const invoiceInput = (tenant: string, unitExclVatCents = 1_000_000_00): IssueTaxInvoiceInput => ({
    tenantId: tenant,
    issueDate: "2026-10-13",
    supplyDate: "2026-10-13",
    recipient: { name: "Test Borrower (Pty) Ltd", address: "2 Test Road, Testville" },
    lines: [{ description: "2026 Testmake TX 200, VIN TEST0000000000001", quantity: 1, unitExclVatCents }],
  })

  beforeAll(async () => {
    for (const suffix of ["main", "race", "bare"]) {
      const tenant = await db.tenant.create({ data: { name: `VAT IT ${tag} ${suffix}`, slug: `vat-it-${tag}-${suffix}` } })
      tenantIds.push(tenant.id)
    }
    ;[tenantId, raceTenantId, bareTenantId] = tenantIds
    for (const id of [tenantId, raceTenantId]) {
      await db.vatConfig.create({
        data: { tenantId: id, vatNumber: "4000000000", registeredName: "Test Lender (Pty) Ltd", address: "1 Test Street" },
      })
    }
  })

  afterAll(async () => {
    // The rows are immutable by design; replica mode skips the guards so the
    // fixture can be removed.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      await tx.creditNote.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await tx.taxInvoiceLine.deleteMany({ where: { invoice: { tenantId: { in: tenantIds } } } })
      await tx.taxInvoice.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await tx.vatConfig.deleteMany({ where: { tenantId: { in: tenantIds } } })
      await tx.tenant.deleteMany({ where: { id: { in: tenantIds } } })
    })
    await Promise.all([db, ...clients].map((client) => client.$disconnect()))
  })

  it("(d) seeds the 15% VAT rate from 1 April 2018, and has none before it", async () => {
    const seed = await db.vatRate.findUnique({ where: { id: "vat_rate_2018_04_01" } })
    expect(seed?.effectiveDate.toISOString().slice(0, 10)).toBe("2018-04-01")
    expect(seed?.rate.toFixed(4)).toBe("0.1500")
    expect((await loadRateOn(db, "2026-10-13")).rateTenThousandths).toBe(1500)
    await expect(loadRateOn(db, "2018-03-31")).rejects.toBeInstanceOf(NoVatRateError)
  })

  it("refuses to issue for a tenant with no VAT configuration", async () => {
    await expect(db.$transaction((tx) => issueTaxInvoice(tx, invoiceInput(bareTenantId)))).rejects.toBeInstanceOf(VatNotConfiguredError)
    expect(await db.taxInvoice.count({ where: { tenantId: bareTenantId } })).toBe(0)
  })

  describe("(a) an issued invoice, its lines and its credit notes are immutable", () => {
    let invoiceId = ""
    let lineId = ""
    let creditNoteId = ""

    beforeAll(async () => {
      const invoice = await db.$transaction((tx) => issueTaxInvoice(tx, invoiceInput(tenantId)))
      invoiceId = invoice.id
      lineId = invoice.lines[0].id
      expect(invoice).toMatchObject({ number: 1, invoiceNumber: "INV-000001", vatCents: 150_000_00, totalInclVatCents: 1_150_000_00 })
      const note = await db.$transaction((tx) => issueCreditNote(tx, {
        tenantId, invoiceId, issueDate: "2026-10-14", reason: "Test price correction", exclVatCents: 1_000_00,
      }))
      creditNoteId = note.id
      expect(note).toMatchObject({ number: 1, creditNoteNumber: "CN-000001", vatCents: 150_00, inclVatCents: 1_150_00 })
    })

    it("refuses UPDATE and DELETE of the invoice", async () => {
      await expect(db.taxInvoice.update({ where: { id: invoiceId }, data: { recipientName: "Tampered" } })).rejects.toThrow(IMMUTABLE)
      await expect(db.taxInvoice.delete({ where: { id: invoiceId } })).rejects.toThrow(IMMUTABLE)
    })

    it("refuses UPDATE and DELETE of a line", async () => {
      await expect(db.taxInvoiceLine.update({ where: { id: lineId }, data: { description: "Tampered" } })).rejects.toThrow(IMMUTABLE)
      await expect(db.taxInvoiceLine.delete({ where: { id: lineId } })).rejects.toThrow(IMMUTABLE)
    })

    it("refuses UPDATE, DELETE and TRUNCATE of a credit note", async () => {
      await expect(db.creditNote.update({ where: { id: creditNoteId }, data: { reason: "Tampered" } })).rejects.toThrow(IMMUTABLE)
      await expect(db.creditNote.delete({ where: { id: creditNoteId } })).rejects.toThrow(IMMUTABLE)
      // Rolled back either way, so a missing guard cannot wipe other suites' rows.
      await expect(db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe('TRUNCATE "CreditNote"')
        throw new Error("TRUNCATE was not refused")
      })).rejects.toThrow(IMMUTABLE)
      expect(await db.creditNote.count({ where: { id: creditNoteId } })).toBe(1)
    })

    it("refuses a credit note beyond the invoice's value, or for another tenant", async () => {
      const over = { tenantId, invoiceId, issueDate: new Date("2026-10-14"), reason: "Test over-credit", exclVatCents: 999_999_99, vatCents: 150_000_00, inclVatCents: 1_149_999_99, number: 0, creditNoteNumber: "" }
      await expect(db.creditNote.create({ data: over })).rejects.toThrow(/may not exceed/)
      await expect(db.creditNote.create({ data: { ...over, tenantId: raceTenantId, exclVatCents: 1, vatCents: 0, inclVatCents: 1 } }))
        .rejects.toThrow(/same tenant/)
    })
  })

  describe("(c) totals must equal the sum of the lines at commit", () => {
    const row = (tenant: string, totalExclVatCents: number) => ({
      tenantId: tenant, number: 0, invoiceNumber: "", issueDate: new Date("2026-10-13"), supplyDate: new Date("2026-10-13"),
      supplierName: "Test Lender (Pty) Ltd", supplierAddress: "1 Test Street", supplierVatNumber: "4000000000",
      recipientName: "Test Borrower", recipientAddress: "2 Test Road", vatRate: "0.1500",
      totalExclVatCents, vatCents: 150, totalInclVatCents: totalExclVatCents + 150,
    })
    const goodLine = { lineNo: 1, description: "Test item", quantity: 1, unitExclVatCents: 1000, exclVatCents: 1000, vatCents: 150, inclVatCents: 1150 }

    it("refuses an invoice whose totals differ from its lines", async () => {
      await expect(db.taxInvoice.create({ data: { ...row(tenantId, 1001), lines: { create: [goodLine] } } })).rejects.toThrow(TOTALS)
    })

    it("refuses an invoice with no lines", async () => {
      await expect(db.taxInvoice.create({ data: row(tenantId, 0) })).rejects.toThrow(TOTALS)
    })

    it("refuses a line added to an invoice after it was issued", async () => {
      const invoice = await db.taxInvoice.create({ data: { ...row(tenantId, 1000), lines: { create: [goodLine] } } })
      await expect(db.taxInvoiceLine.create({ data: { ...goodLine, lineNo: 2, invoiceId: invoice.id } })).rejects.toThrow(TOTALS)
    })
  })

  it("(b) numbers concurrent issues 1..20 with no gap or duplicate, even across a rolled-back issue", async () => {
    for (let i = 0; i < 20; i++) clients.push(newClient())
    const issue = (client: Client) => client.$transaction((tx) => issueTaxInvoice(tx, invoiceInput(raceTenantId, 100)), { timeout: 30_000, maxWait: 30_000 })

    // Ten in parallel, each on its own connection.
    const firstTen = await Promise.all(clients.slice(0, 10).map(issue))
    expect(firstTen.map((i) => i.number).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    // An issue takes number 11, holds it while ten more queue behind it, then
    // rolls back. The ten must reuse 11: a gap here is a burnt number.
    let rolledBackAt = 0
    let release: () => void = () => undefined
    let issued: (n: number) => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    const doomedIssued = new Promise<number>((resolve) => { issued = resolve })
    const doomedClient = newClient()
    clients.push(doomedClient)
    const doomed = doomedClient.$transaction(async (tx) => {
      issued((await issueTaxInvoice(tx, invoiceInput(raceTenantId, 100))).number)
      await held
      rolledBackAt = Date.now()
      throw new Error("deliberate rollback")
    }, { timeout: 30_000 })
    const doomedNumber = await Promise.race([doomedIssued, doomed.then(() => 0)])

    const secondTen = clients.slice(10, 20).map(async (client) => ({ invoice: await issue(client), at: Date.now() }))
    await new Promise((resolve) => setTimeout(resolve, 500))
    release()
    await expect(doomed).rejects.toThrow("deliberate rollback")
    const second = await Promise.all(secondTen)

    expect(doomedNumber).toBe(11)
    // Every one of them waited for the rollback: the numbering lock was held.
    for (const { at } of second) expect(at).toBeGreaterThanOrEqual(rolledBackAt)
    expect(second.map(({ invoice }) => invoice.number).sort((a, b) => a - b)).toEqual([11, 12, 13, 14, 15, 16, 17, 18, 19, 20])

    const stored = await db.taxInvoice.findMany({ where: { tenantId: raceTenantId }, orderBy: { number: "asc" }, select: { number: true, invoiceNumber: true } })
    expect(stored.map((s) => s.number)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1))
    expect(stored[19].invoiceNumber).toBe("INV-000020")
  }, 60_000)

  it("(e) ignores a supplied number and display number: the next number is the tenant's max + 1", async () => {
    const before = await db.taxInvoice.aggregate({ where: { tenantId }, _max: { number: true } })
    const forged = await db.taxInvoice.create({ data: {
      tenantId, number: 999_999, invoiceNumber: "INV-999999", issueDate: new Date("2026-10-13"), supplyDate: new Date("2026-10-13"),
      supplierName: "Test Lender (Pty) Ltd", supplierAddress: "1 Test Street", supplierVatNumber: "4000000000",
      recipientName: "Test Borrower", recipientAddress: "2 Test Road", vatRate: "0.1500", totalExclVatCents: 1000, vatCents: 150, totalInclVatCents: 1150,
      lines: { create: [{ lineNo: 1, description: "Test item", quantity: 1, unitExclVatCents: 1000, exclVatCents: 1000, vatCents: 150, inclVatCents: 1150 }] },
    } })
    const next = (before._max.number ?? 0) + 1
    expect(forged).toMatchObject({ number: next, invoiceNumber: `INV-${String(next).padStart(6, "0")}` })
  })

  describe("(f) VAT consistent with the invoice rate", () => {
    const header = { number: 0, invoiceNumber: "", issueDate: new Date("2026-10-13"), supplyDate: new Date("2026-10-13"),
      supplierName: "Test Lender (Pty) Ltd", supplierAddress: "1 Test Street", supplierVatNumber: "4000000000",
      recipientName: "Test Borrower", recipientAddress: "2 Test Road", vatRate: "0.1500" }
    const LINE_VAT = /line's VAT must be the invoice rate applied half-up/

    it("refuses a line whose VAT is neither rule's (exclusive 1000 at 15% is 150, not 151)", async () => {
      await expect(db.taxInvoice.create({ data: { ...header, tenantId, totalExclVatCents: 1000, vatCents: 151, totalInclVatCents: 1151,
        lines: { create: [{ lineNo: 1, description: "Test item", quantity: 1, unitExclVatCents: 1000, exclVatCents: 1000, vatCents: 151, inclVatCents: 1151 }] } } }))
        .rejects.toThrow(LINE_VAT)
    })

    it("issues a VAT-inclusive price whose exclusive + VAT is exact (tax fraction) and the database accepts it", async () => {
      const invoice = await db.$transaction((tx) => issueTaxInvoice(tx, { ...invoiceInput(tenantId), lines: [{ description: "Test asset", inclVatCents: 115_000_004 }] }))
      expect(invoice.lines[0]).toMatchObject({ exclVatCents: 100_000_003, vatCents: 15_000_001, inclVatCents: 115_000_004 })
    })

    it("refuses a credit note whose VAT is not the invoice rate on its value, or not the exact remainder on a full credit", async () => {
      const invoice = await db.$transaction((tx) => issueTaxInvoice(tx, invoiceInput(tenantId, 1000)))
      const note = { tenantId, invoiceId: invoice.id, issueDate: new Date("2026-10-14"), reason: "Test credit", number: 0, creditNoteNumber: "" }
      await expect(db.creditNote.create({ data: { ...note, exclVatCents: 10, vatCents: 1, inclVatCents: 11 } })).rejects.toThrow(/half-up to its value/)
      await db.creditNote.create({ data: { ...note, exclVatCents: 10, vatCents: 2, inclVatCents: 12 } })
      await expect(db.creditNote.create({ data: { ...note, exclVatCents: 990, vatCents: 147, inclVatCents: 1137 } })).rejects.toThrow(/exactly the remaining VAT/)
      await db.creditNote.create({ data: { ...note, exclVatCents: 990, vatCents: 148, inclVatCents: 1138 } })
    })
  })

  it("(g) a deferred violation surfaces inside issueTaxInvoice and issueCreditNote, not at a COMMIT Prisma would report as success", async () => {
    const lineless = { tenantId, number: 0, invoiceNumber: "", issueDate: new Date("2026-10-13"), supplyDate: new Date("2026-10-13"),
      supplierName: "S", supplierAddress: "A", supplierVatNumber: "4000000000", recipientName: "R", recipientAddress: "B",
      vatRate: "0.1500", totalExclVatCents: 0, vatCents: 0, totalInclVatCents: 0 }
    const good = await db.$transaction((tx) => issueTaxInvoice(tx, invoiceInput(tenantId, 1000)))
    const errors: unknown[] = []
    for (const issue of [
      (tx: TaxInvoiceDb & CreditNoteDb) => issueTaxInvoice(tx, invoiceInput(tenantId, 1000)),
      (tx: TaxInvoiceDb & CreditNoteDb) => issueCreditNote(tx, { tenantId, invoiceId: good.id, issueDate: "2026-10-14", reason: "Test", exclVatCents: 10 }),
    ]) {
      await db.$transaction(async (tx) => {
        await tx.taxInvoice.create({ data: lineless }) // its totals check is deferred
        await issue(tx).catch((error: unknown) => errors.push(error))
      }).catch(() => undefined)
    }
    expect(errors.map(String)).toEqual([expect.stringMatching(TOTALS), expect.stringMatching(TOTALS)])
  })
})
