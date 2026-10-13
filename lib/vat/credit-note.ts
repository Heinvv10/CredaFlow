// Credit notes: the only correction to an issued tax invoice (VAT Act s21).
// The database assigns the gap-free per-tenant number ("CN-000001"), refuses
// UPDATE and DELETE, and refuses a credit note for another tenant's invoice
// or one that would credit more value or VAT than the invoice charged
// (migration 20261013100000).
import type { Prisma } from "@prisma/client"
import { vatOnExclusive } from "./amounts"
import type { VatTransaction } from "./db"
import { dbDate } from "./tax-invoice"
import { rateTenThousandthsOf } from "./vat-rate"

export class TaxInvoiceNotFoundError extends Error {
  constructor(readonly invoiceId: string) {
    super(`Tax invoice ${invoiceId} was not found for this tenant`)
    this.name = "TaxInvoiceNotFoundError"
  }
}

export interface IssueCreditNoteInput {
  tenantId: string
  invoiceId: string
  /** ISO YYYY-MM-DD. */
  issueDate: string
  reason: string
  /** VAT-exclusive value credited. */
  exclVatCents: number
  createdById?: string | null
}

export type CreditNoteDb = Pick<VatTransaction, "taxInvoice" | "creditNote">

export type IssuedCreditNote = Prisma.CreditNoteGetPayload<Record<string, never>>

interface Credited {
  exclVatCents: number
  vatCents: number
}

/**
 * Pure: the VAT on a credit, at the rate the invoice charged. Crediting the
 * whole remaining value credits the whole remaining VAT, so a full credit
 * reverses the invoice to the cent even where its per-line rounding differs
 * from VAT on the total; a partial credit's VAT is half-up on its value.
 */
export function creditNoteVat(
  invoice: Credited & { vatRate: Prisma.Decimal | string },
  alreadyCredited: Credited,
  exclVatCents: number,
): number {
  if (!Number.isSafeInteger(exclVatCents) || exclVatCents <= 0) {
    throw new RangeError("exclVatCents must be a positive integer number of cents")
  }
  const remainingExcl = invoice.exclVatCents - alreadyCredited.exclVatCents
  if (exclVatCents > remainingExcl) {
    throw new RangeError(`credit of ${exclVatCents} cents exceeds the ${remainingExcl} cents still creditable`)
  }
  if (exclVatCents === remainingExcl) return invoice.vatCents - alreadyCredited.vatCents
  return vatOnExclusive(exclVatCents, rateTenThousandthsOf(invoice.vatRate))
}

/** Issues a credit note against a tax invoice, inside the caller's transaction. */
export async function issueCreditNote(tx: CreditNoteDb, input: IssueCreditNoteInput): Promise<IssuedCreditNote> {
  const issueDate = dbDate(input.issueDate, "issueDate")
  const reason = input.reason.trim()
  if (reason === "") throw new RangeError("reason is required")

  const invoice = await tx.taxInvoice.findFirst({
    where: { id: input.invoiceId, tenantId: input.tenantId },
    select: { totalExclVatCents: true, vatCents: true, vatRate: true },
  })
  if (!invoice) throw new TaxInvoiceNotFoundError(input.invoiceId)
  const credited = await tx.creditNote.aggregate({
    where: { invoiceId: input.invoiceId },
    _sum: { exclVatCents: true, vatCents: true },
  })
  const vatCents = creditNoteVat(
    { exclVatCents: invoice.totalExclVatCents, vatCents: invoice.vatCents, vatRate: invoice.vatRate },
    { exclVatCents: credited._sum.exclVatCents ?? 0, vatCents: credited._sum.vatCents ?? 0 },
    input.exclVatCents,
  )

  return tx.creditNote.create({
    data: {
      tenantId: input.tenantId,
      // Placeholders: the CreditNote_assign_number trigger overwrites both.
      number: 0,
      creditNoteNumber: "",
      issueDate,
      invoiceId: input.invoiceId,
      reason,
      exclVatCents: input.exclVatCents,
      vatCents,
      inclVatCents: input.exclVatCents + vatCents,
      createdById: input.createdById ?? null,
    },
  })
}
