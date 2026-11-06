/**
 * Ingests a verified mobile-money callback (lib/mobile-money/types.ts) for one
 * lender. The tenant comes from the caller (the webhook resolves it from the
 * host), never from the callback.
 *
 * A paybill (C2B) payment is matched on its account number (BillRefNumber)
 * against Loan.reference, trimmed and case-folded, and booked through
 * lib/mobile-money/book.ts. One that names no loan is stored UNMATCHED for
 * staff and books nothing. An STK push result settles the push the borrower
 * started (lib/mobile-money/stk-result.ts).
 *
 * A callback from a simulating provider, where this deployment does not permit
 * that simulation, books nothing: it waits for a person (NEEDS_REVIEW).
 */
import { Prisma } from "@prisma/client"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { auditSettled, bookReceipt, settleWithoutReceipt, valueDate, type IngestOutcome, type MobileMoneyDb, type Settle } from "./book"
import { ingestStkResult, type IngestContext } from "./stk-result"
import type { MobileMoneyCallback, MobileMoneyProvider } from "./types"

export type { IngestOutcome, MobileMoneyDb } from "./book"

/**
 * The lender's one loan whose reference is `reference`, compared exactly after
 * case-folding, or null (none, or more than one). Never LIKE: Prisma's
 * case-insensitive `equals` is ILIKE, where a `_` or `%` the payer typed would
 * match another borrower's loan.
 */
export async function matchLoanByReference(db: Pick<MobileMoneyDb, "$queryRaw">, tenantId: string, reference: string): Promise<string | null> {
  const wanted = reference.trim()
  if (!wanted) return null
  const loans = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Loan" WHERE "tenantId" = ${tenantId} AND lower("reference") = lower(${wanted}) LIMIT 2
  `)
  return loans.length === 1 ? loans[0].id : null
}

export async function ingestMobileMoneyCallback(db: MobileMoneyDb, args: {
  tenantId: string
  provider: MobileMoneyProvider
  callback: MobileMoneyCallback
  now?: Date
}): Promise<IngestOutcome> {
  const simulation = args.provider.simulation()
  const ctx: IngestContext = {
    tenantId: args.tenantId,
    providerId: args.provider.id,
    simulated: simulation !== null,
    forbidden: simulation && !isSimulationPermitted(simulation)
      ? `Simulated callback (${simulation}) on an environment that does not permit that simulation: not booked`
      : null,
    now: args.now ?? new Date(),
  }
  const { callback } = args
  if (callback.kind !== "C2B") return ingestStkResult(db, ctx, callback)
  return ingestPaybill(db, ctx, callback)
}

async function ingestPaybill(db: MobileMoneyDb, ctx: IngestContext, cb: Extract<MobileMoneyCallback, { kind: "C2B" }>): Promise<IngestOutcome> {
  const { tenantId, providerId } = ctx
  const seen = await db.mobileMoneyTransaction.findFirst({ where: { tenantId, provider: providerId, transId: cb.transId }, select: { id: true } })
  if (seen) return { outcome: "DUPLICATE" }

  const billRef = cb.billRef.trim()
  const loanId = await matchLoanByReference(db, tenantId, billRef)

  const settle: Settle = async (tx, settled) => {
    const row = await tx.mobileMoneyTransaction.create({
      data: {
        tenantId, provider: providerId, transId: cb.transId, msisdnLast4: cb.msisdnLast4, billRef, amount: cb.amountCents,
        transactedAt: cb.transactedAt, simulated: ctx.simulated, status: settled.status,
        loanId: settled.status === "UNMATCHED" ? null : loanId,
        paymentId: "paymentId" in settled ? settled.paymentId : null,
        reviewReason: "reviewReason" in settled ? settled.reviewReason : null,
      },
      select: { id: true },
    })
    await auditSettled(tx, {
      tenantId, transactionId: row.id, provider: providerId, transId: cb.transId, amount: cb.amountCents,
      loanId: settled.status === "UNMATCHED" ? null : loanId, simulated: ctx.simulated, settled,
    })
    return row.id
  }

  if (ctx.forbidden) return settleWithoutReceipt(db, settle, { status: "NEEDS_REVIEW", reviewReason: ctx.forbidden })
  if (!loanId) return settleWithoutReceipt(db, settle, { status: "UNMATCHED" })
  return bookReceipt(db, {
    tenantId, loanId, amountCents: cb.amountCents, transId: cb.transId,
    receivedAt: valueDate(cb.transactedAt, ctx.now), simulated: ctx.simulated,
  }, settle)
}
