import { describe, expect, it, vi } from "vitest"
import { creditNoteVat, issueCreditNote, type CreditNoteDb } from "./credit-note"

// Two lines whose per-line VAT (150 + 2) exceeds VAT on the total (151).
const INVOICE = { exclVatCents: 1009, vatCents: 152, vatRate: "0.1500" }

describe("creditNoteVat", () => {
  it("credits the whole remaining VAT when the whole remaining value is credited", () => {
    expect(creditNoteVat(INVOICE, { exclVatCents: 0, vatCents: 0 }, 1009)).toBe(152)
    expect(creditNoteVat(INVOICE, { exclVatCents: 10, vatCents: 2 }, 999)).toBe(150)
  })

  it("computes a partial credit's VAT half-up at the invoice's rate", () => {
    expect(creditNoteVat(INVOICE, { exclVatCents: 0, vatCents: 0 }, 10)).toBe(2) // 1.50
    expect(creditNoteVat(INVOICE, { exclVatCents: 0, vatCents: 0 }, 3)).toBe(0) // 0.45
  })

  it("refuses more than is still creditable, and a non-positive amount", () => {
    expect(() => creditNoteVat(INVOICE, { exclVatCents: 1000, vatCents: 150 }, 10)).toThrow(/exceeds/)
    expect(() => creditNoteVat(INVOICE, { exclVatCents: 0, vatCents: 0 }, 0)).toThrow(RangeError)
  })
})

describe("issueCreditNote", () => {
  it("scopes the credited sum to the tenant and forces the deferred checks before returning", async () => {
    const calls: string[] = []
    const aggregate = vi.fn(async () => ({ _sum: { exclVatCents: null, vatCents: null } }))
    const db = {
      taxInvoice: { findFirst: vi.fn(async () => ({ totalExclVatCents: 1009, vatCents: 152, vatRate: "0.1500" })) },
      creditNote: {
        aggregate,
        create: vi.fn(async (args: { data: Record<string, unknown> }) => {
          calls.push("create")
          return args.data
        }),
      },
      $executeRawUnsafe: vi.fn(async (sql: string) => {
        calls.push(sql)
        return 0
      }),
    }
    const note = await issueCreditNote(db as unknown as CreditNoteDb, {
      tenantId: "t1", invoiceId: "inv1", issueDate: "2026-10-14", reason: "Test correction", exclVatCents: 10,
    })
    expect(note).toMatchObject({ exclVatCents: 10, vatCents: 2, inclVatCents: 12 })
    expect(aggregate).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", invoiceId: "inv1" } }))
    expect(calls).toEqual(["create", "SET CONSTRAINTS ALL IMMEDIATE"])
  })
})
