/**
 * Real-DB proof of the VAT rate anchor in migration 20261013100000: VatRate
 * rows are history (no UPDATE, DELETE or TRUNCATE; a new row only for a date
 * after today, SAST), and a tax invoice's vatRate must be the rate in force on
 * its supply date.
 *
 *   RUN_VAT_INVOICE_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/vat/vat-rate.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"

const suite = process.env.RUN_VAT_INVOICE_IT === "1" ? describe : describe.skip

const HISTORY = /VatRate is history/
const AFTER_TODAY = /must take effect after today/
const IN_FORCE = /VAT rate must be the rate in force on its supply date/

suite("VatRate is the immutable anchor of every invoice's rate (real DB)", () => {
  const db = new PrismaClient()
  const tag = randomUUID().replaceAll("-", "").slice(0, 12)
  let tenantId = ""
  const seedId = "vat_rate_2018_04_01"
  const shift = (days: number) => sastCalendarDate(new Date(Date.now() + days * 86_400_000))
  // Rolled back whatever happens, so an accepted row never outlives the test.
  const inRollback = (statement: string) => db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(statement)
    throw new Error("ROLLBACK")
  })

  beforeAll(async () => {
    tenantId = (await db.tenant.create({ data: { name: `VAT rate IT ${tag}`, slug: `vat-rate-it-${tag}` } })).id
  })

  afterAll(async () => {
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      await tx.taxInvoiceLine.deleteMany({ where: { invoice: { tenantId } } })
      await tx.taxInvoice.deleteMany({ where: { tenantId } })
      await tx.tenant.deleteMany({ where: { id: tenantId } })
    })
    await db.$disconnect()
  })

  it("refuses UPDATE, DELETE and TRUNCATE of a rate", async () => {
    await expect(db.vatRate.update({ where: { id: seedId }, data: { rate: "0.1400" } })).rejects.toThrow(HISTORY)
    await expect(db.vatRate.delete({ where: { id: seedId } })).rejects.toThrow(HISTORY)
    await expect(inRollback('TRUNCATE "VatRate"')).rejects.toThrow(HISTORY)
    expect((await db.vatRate.findUniqueOrThrow({ where: { id: seedId } })).rate.toFixed(4)).toBe("0.1500")
  })

  it("refuses a new rate in force today or earlier; accepts one from tomorrow", async () => {
    const insert = (day: string) =>
      `INSERT INTO "VatRate" ("id", "effectiveDate", "rate") VALUES ('vr_${tag}_${day}', '${day}', 0.1600)`
    await expect(inRollback(insert("2020-01-01"))).rejects.toThrow(AFTER_TODAY)
    await expect(inRollback(insert(shift(0)))).rejects.toThrow(AFTER_TODAY)
    await expect(inRollback(insert(shift(1)))).rejects.toThrow("ROLLBACK")
  })

  describe("a tax invoice's rate", () => {
    const invoice = (vatRate: string, supplyDate: string) => {
      const vatCents = Math.round(1000 * Number(vatRate))
      return db.taxInvoice.create({ data: {
        tenantId, number: 0, invoiceNumber: "", issueDate: new Date("2026-10-13"), supplyDate: new Date(supplyDate),
        supplierName: "Test Lender (Pty) Ltd", supplierAddress: "1 Test Street", supplierVatNumber: "4000000000",
        recipientName: "Test Borrower", recipientAddress: "2 Test Road", vatRate,
        totalExclVatCents: 1000, vatCents, totalInclVatCents: 1000 + vatCents,
        lines: { create: [{ lineNo: 1, description: "Test item", quantity: 1, unitExclVatCents: 1000, exclVatCents: 1000, vatCents, inclVatCents: 1000 + vatCents }] },
      } })
    }

    it("is refused when it is not the rate in force on the supply date", async () => {
      await expect(invoice("0.1400", "2026-10-13")).rejects.toThrow(IN_FORCE)
      await expect(invoice("0.1500", "2018-03-31")).rejects.toThrow(IN_FORCE)
      expect(await db.taxInvoice.count({ where: { tenantId } })).toBe(0)
    })

    it("is accepted when it is (0.15 and 0.1500 are the same decimal)", async () => {
      expect((await invoice("0.15", "2026-10-13")).vatRate.toFixed(4)).toBe("0.1500")
      expect((await invoice("0.1500", "2018-04-01")).vatRate.toFixed(4)).toBe("0.1500")
    })
  })
})
