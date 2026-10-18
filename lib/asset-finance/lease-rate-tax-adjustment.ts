import { Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { issueCreditNote } from "@/lib/vat/credit-note"
import { issueTaxInvoice } from "@/lib/vat/tax-invoice"
import { isoOfDbDate } from "./dates"
import { rateTaxDocuments, type RateTaxDocument } from "./rate-tax-documents"
import type { RepriceTx } from "./reprice-loan"

export interface PendingLeaseRateTax {
  rentalId: string
  periodNo: number
  exclVatCents: number
  estimatedGrossCents: number
}
export const objectEvidence = (value: Prisma.JsonValue) =>
  value && typeof value === "object" && !Array.isArray(value) ? value : {}
export function pendingLeaseRateTax(value: Prisma.JsonValue): PendingLeaseRateTax[] {
  const pending = objectEvidence(value).pendingTaxAdjustments
  if (!Array.isArray(pending)) return []
  return pending.filter(
    (x) =>
      x &&
      typeof x === "object" &&
      !Array.isArray(x) &&
      typeof x.rentalId === "string" &&
      Number.isSafeInteger(x.periodNo) &&
      Number.isSafeInteger(x.exclVatCents) &&
      Number.isSafeInteger(x.estimatedGrossCents)
  ) as unknown as PendingLeaseRateTax[]
}

/** Each note adjusts this rental's own original supply, at its actual VAT rate. */
export async function issueRentalRateTaxDocument(
  tx: RepriceTx,
  input: {
    tenantId: string
    loanId: string
    invoiceId: string
    periodNo: number
    exclVatCents: number
    issueDate: string
    effectiveDate: string
    actorUserId?: string | null
    reason?: string
  }
): Promise<RateTaxDocument> {
  const original = await tx.taxInvoice.findFirstOrThrow({
    where: { tenantId: input.tenantId, id: input.invoiceId, loanId: input.loanId },
  })
  const reason =
    input.reason ?? `Rental-only reference-rate correction, period ${input.periodNo}, effective ${input.effectiveDate}`
  const common = {
    invoiceId: original.id,
    periodNo: input.periodNo,
    originalInvoiceNumber: original.invoiceNumber,
    issueDate: input.issueDate,
    reason,
    supplierName: original.supplierName,
    supplierAddress: original.supplierAddress,
    supplierVatNumber: original.supplierVatNumber,
    recipientName: original.recipientName,
    recipientAddress: original.recipientAddress,
    recipientVatNumber: original.recipientVatNumber,
    vatRate: original.vatRate.toString(),
  }
  if (input.exclVatCents < 0) {
    const note = await issueCreditNote(tx, {
      tenantId: input.tenantId,
      invoiceId: original.id,
      issueDate: input.issueDate,
      reason,
      exclVatCents: -input.exclVatCents,
      createdById: input.actorUserId,
    })
    return {
      ...common,
      kind: "CREDIT_NOTE",
      id: note.id,
      number: note.creditNoteNumber,
      exclVatCents: -note.exclVatCents,
      vatCents: -note.vatCents,
      inclVatCents: -note.inclVatCents,
    }
  }
  const note = await issueTaxInvoice(tx, {
    tenantId: input.tenantId,
    loanId: input.loanId,
    issueDate: input.issueDate,
    supplyDate: isoOfDbDate(original.supplyDate),
    debitNoteForInvoiceId: original.id,
    adjustmentReason: reason,
    recipient: {
      name: original.recipientName,
      address: original.recipientAddress,
      vatNumber: original.recipientVatNumber,
    },
    lines: [{ description: reason, quantity: 1, unitExclVatCents: input.exclVatCents }],
    createdById: input.actorUserId,
  })
  return {
    ...common,
    kind: "DEBIT_NOTE",
    id: note.id,
    number: note.invoiceNumber,
    exclVatCents: note.totalExclVatCents,
    vatCents: note.vatCents,
    inclVatCents: note.totalInclVatCents,
  }
}

type TaxTx = Pick<
  RepriceTx,
  | "assetFinanceRateCorrection"
  | "assetFinanceRateNotice"
  | "leaseRental"
  | "contractRate"
  | "taxInvoice"
  | "creditNote"
  | "vatConfig"
  | "vatRate"
  | "auditLog"
  | "$executeRaw"
  | "$executeRawUnsafe"
>
/** Called only after the actual rental invoice is bound, or unmade rental consideration
 * is cancelled or superseded by an actual zero-rental floor. The unique causal event consumes the pending supply once. */
export async function consumeDeferredLeaseRateTax(
  tx: TaxTx,
  input: {
    tenantId: string
    loanId: string
    rentalIds: string[]
    invoiceId?: string
    today: string
    actorUserId: string | null
    replacedByRentalFloor?: boolean
  }
): Promise<void> {
  const sources = await tx.assetFinanceRateCorrection.findMany({
    where: { tenantId: input.tenantId, loanId: input.loanId, reason: "LATE_CLOSED_LEASE_RATE" },
    include: { contractRate: { select: { effectiveDate: true } } },
  })
  for (const source of sources)
    for (const pending of pendingLeaseRateTax(source.contractualRows)) {
      if (!input.rentalIds.includes(pending.rentalId)) continue
      const cause = `LEASE_TAX:${source.id}:${pending.rentalId}`
      if (await tx.assetFinanceRateCorrection.findUnique({ where: { cause } })) continue
      const rental = await tx.leaseRental.findFirstOrThrow({
        where: { tenantId: input.tenantId, loanId: input.loanId, id: pending.rentalId },
        select: { taxInvoiceId: true, cancelledAt: true, dueDate: true, rentalExclVatCents: true },
      })
      if (input.invoiceId) {
        if (rental.taxInvoiceId !== input.invoiceId || rental.cancelledAt)
          throw new Error("Deferred rate tax document needs this rental's actual original invoice")
      } else if (
        input.replacedByRentalFloor
          ? rental.cancelledAt || rental.taxInvoiceId || rental.rentalExclVatCents !== 0
          : !rental.cancelledAt || rental.taxInvoiceId || isoOfDbDate(rental.dueDate) <= input.today
      ) {
        throw new Error("Deferred rate tax adjustment needs a cancelled or zero-valued unmade rental supply")
      }
      const doc = input.invoiceId
        ? await issueRentalRateTaxDocument(tx as RepriceTx, {
            ...input,
            invoiceId: input.invoiceId,
            periodNo: pending.periodNo,
            exclVatCents: pending.exclVatCents,
            issueDate: input.today,
            effectiveDate: isoOfDbDate(source.contractRate.effectiveDate),
          })
        : null
      const delta = (doc?.inclVatCents ?? 0) - pending.estimatedGrossCents
      const total = await tx.assetFinanceRateCorrection.aggregate({
        where: { tenantId: input.tenantId, loanId: input.loanId },
        _sum: { amountCents: true },
      })
      await tx.assetFinanceRateCorrection.create({
        data: {
          tenantId: input.tenantId,
          loanId: input.loanId,
          contractRateId: source.contractRateId,
          cause,
          amountCents: delta,
          cumulativeAmountCents: (total._sum.amountCents ?? 0) + delta,
          reason: doc ? "LEASE_SUPPLY_TAX_ADJUSTMENT" : "LEASE_SUPPLY_TAX_CANCELLED",
          contractualRows: {
            sourceCorrectionId: source.id,
            rentalId: pending.rentalId,
            periodNo: pending.periodNo,
            exclVatAdjustmentCents: doc ? 0 : -pending.exclVatCents,
            replacedByRentalFloor: input.replacedByRentalFloor ?? false,
            taxDocuments: doc ? [doc] : [],
          } as unknown as Prisma.InputJsonValue,
        },
      })
      const notice = await tx.assetFinanceRateNotice.findFirst({
        where: { tenantId: input.tenantId, loanId: input.loanId, contractRateId: source.contractRateId },
      })
      if (notice) {
        const events = await tx.assetFinanceRateCorrection.findMany({
          where: { tenantId: input.tenantId, loanId: input.loanId, cause: { startsWith: `LEASE_TAX:${source.id}:` } },
          select: { cause: true },
        })
        const remaining = pendingLeaseRateTax(source.contractualRows).some(
          (item) => !events.some((event) => event.cause === `LEASE_TAX:${source.id}:${item.rentalId}`)
        )
        await tx.assetFinanceRateNotice.update({
          where: { id: notice.id, tenantId: input.tenantId },
          data: {
            historicalBalanceAdjustmentCents: notice.historicalBalanceAdjustmentCents + delta,
            taxAdjustmentPending: remaining,
            taxAdjustmentRevision: { increment: 1 },
            taxDocuments: [
              ...rateTaxDocuments(notice.taxDocuments),
              ...(doc ? [doc] : []),
            ] as unknown as Prisma.InputJsonValue,
            completedAt: null,
            lastOutcomes: Prisma.DbNull,
          },
        })
      }
      await logAuditStrict(
        {
          tenantId: input.tenantId,
          userId: input.actorUserId ?? undefined,
          action: AuditAction.LEASE_RENTAL_INVOICED,
          entity: "Loan",
          entityId: input.loanId,
          newValue: {
            source: doc
              ? "deferred_rate_tax_supply"
              : input.replacedByRentalFloor
                ? "deferred_rate_tax_superseded_by_floor"
                : "deferred_rate_tax_cancelled",
            sourceCorrectionId: source.id,
            rentalId: pending.rentalId,
            amountCents: delta,
            taxDocuments: doc ? [doc] : [],
          },
        },
        tx
      )
    }
}

/** Immutable period price amendments survive the later replacement of the rental claim by damages. */
export async function amendedLeaseRentals<T extends { periodNo: number; rentalExclVatCents: number }>(
  tx: Pick<TaxTx, "assetFinanceRateCorrection">,
  tenantId: string,
  loanId: string,
  rentals: T[]
): Promise<T[]> {
  const sources = await tx.assetFinanceRateCorrection.findMany({
    where: {
      tenantId,
      loanId,
      reason: { in: ["LATE_CLOSED_LEASE_RATE", "RATE_PAYOFF_CREDIT", "LEASE_SUPPLY_TAX_CANCELLED"] },
    },
    select: { reason: true, contractualRows: true },
  })
  return rentals.map((rental) => {
    let delta = 0
    for (const source of sources) {
      const evidence = objectEvidence(source.contractualRows)
      if (
        source.reason === "LEASE_SUPPLY_TAX_CANCELLED" &&
        evidence.replacedByRentalFloor === true &&
        evidence.periodNo === rental.periodNo
      )
        delta += Number(evidence.exclVatAdjustmentCents ?? 0)
      const parts = evidence.periodAdjustments
      if (Array.isArray(parts))
        for (const part of parts)
          if (
            part &&
            typeof part === "object" &&
            !Array.isArray(part) &&
            part.periodNo === rental.periodNo &&
            typeof part.exclVatCents === "number"
          )
            delta += part.exclVatCents
    }
    const rentalExclVatCents = rental.rentalExclVatCents + delta
    if (!Number.isSafeInteger(rentalExclVatCents) || rentalExclVatCents < 0)
      throw new RangeError("Amended rental consideration cannot be negative")
    return { ...rental, rentalExclVatCents }
  })
}

/** Cancellation replaces only future rental claims. Preserve their issued notes,
 * credit any remaining debit-note supply and neutralise the old face correction once. */
export async function cancelSuppliedLeaseRateAdjustments(
  tx: TaxTx,
  input: { tenantId: string; loanId: string; rentalIds: string[]; today: string; actorUserId: string | null }
): Promise<void> {
  const sources = await tx.assetFinanceRateCorrection.findMany({
    where: { tenantId: input.tenantId, loanId: input.loanId, reason: "LATE_CLOSED_LEASE_RATE" },
  })
  for (const source of sources) {
    const supplyEvents = await tx.assetFinanceRateCorrection.findMany({
      where: {
        tenantId: input.tenantId,
        loanId: input.loanId,
        reason: "LEASE_SUPPLY_TAX_ADJUSTMENT",
        cause: { startsWith: `LEASE_TAX:${source.id}:` },
      },
    })
    const docs = [
      ...rateTaxDocuments(objectEvidence(source.contractualRows).taxDocuments ?? null),
      ...supplyEvents.flatMap((event) => rateTaxDocuments(objectEvidence(event.contractualRows).taxDocuments ?? null)),
    ]
    for (const rentalId of input.rentalIds) {
      const rental = await tx.leaseRental.findFirstOrThrow({
        where: { tenantId: input.tenantId, loanId: input.loanId, id: rentalId },
        select: { periodNo: true, taxInvoiceId: true, cancelledAt: true, dueDate: true },
      })
      if (!rental.taxInvoiceId || isoOfDbDate(rental.dueDate) <= input.today) continue
      const own = docs.filter((doc) => doc.periodNo === rental.periodNo && doc.invoiceId === rental.taxInvoiceId)
      if (!own.length) continue
      const cause = `LEASE_SUPPLIED_RATE_CANCEL:${source.id}:${rentalId}`
      if (await tx.assetFinanceRateCorrection.findUnique({ where: { cause } })) continue
      const cancellations: RateTaxDocument[] = []
      for (const doc of own.filter((doc) => doc.kind === "DEBIT_NOTE")) {
        const prior = await tx.creditNote.aggregate({
          where: { tenantId: input.tenantId, invoiceId: doc.id },
          _sum: { exclVatCents: true },
        })
        const remaining = doc.exclVatCents - (prior._sum.exclVatCents ?? 0)
        if (remaining > 0)
          cancellations.push(
            await issueRentalRateTaxDocument(tx as RepriceTx, {
              ...input,
              invoiceId: doc.id,
              periodNo: rental.periodNo,
              exclVatCents: -remaining,
              issueDate: input.today,
              effectiveDate: input.today,
              reason: `Lease cancellation effective ${input.today}: reversal of rental reference-rate debit note ${doc.number}`,
            })
          )
      }
      const delta = -own.reduce((sum, doc) => sum + doc.inclVatCents, 0)
      const total = await tx.assetFinanceRateCorrection.aggregate({
        where: { tenantId: input.tenantId, loanId: input.loanId },
        _sum: { amountCents: true },
      })
      await tx.assetFinanceRateCorrection.create({
        data: {
          tenantId: input.tenantId,
          loanId: input.loanId,
          contractRateId: source.contractRateId,
          cause,
          amountCents: delta,
          cumulativeAmountCents: (total._sum.amountCents ?? 0) + delta,
          reason: "LEASE_SUPPLY_TAX_CANCELLED",
          contractualRows: {
            sourceCorrectionId: source.id,
            rentalId,
            periodNo: rental.periodNo,
            exclVatAdjustmentCents: -own.reduce((sum, doc) => sum + doc.exclVatCents, 0),
            taxDocuments: cancellations,
          } as unknown as Prisma.InputJsonValue,
        },
      })
      const notice = await tx.assetFinanceRateNotice.findFirst({
        where: { tenantId: input.tenantId, loanId: input.loanId, contractRateId: source.contractRateId },
      })
      if (notice)
        await tx.assetFinanceRateNotice.update({
          where: { id: notice.id, tenantId: input.tenantId },
          data: {
            historicalBalanceAdjustmentCents: notice.historicalBalanceAdjustmentCents + delta,
            taxAdjustmentRevision: { increment: 1 },
            taxDocuments: [
              ...rateTaxDocuments(notice.taxDocuments),
              ...cancellations,
            ] as unknown as Prisma.InputJsonValue,
            completedAt: null,
            lastOutcomes: Prisma.DbNull,
          },
        })
      await logAuditStrict(
        {
          tenantId: input.tenantId,
          userId: input.actorUserId ?? undefined,
          action: AuditAction.LEASE_EARLY_TERMINATION_ACCEPTED,
          entity: "Loan",
          entityId: input.loanId,
          newValue: {
            source: "supplied_rate_claim_cancelled",
            sourceCorrectionId: source.id,
            rentalId,
            amountCents: delta,
            taxDocuments: cancellations,
          },
        },
        tx
      )
    }
  }
}
