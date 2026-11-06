/**
 * "Pay with M-Pesa": asks the provider to prompt the borrower's phone for a
 * payment to the lender's paybill, account = the loan reference.
 *
 * Claim before send (lib/payouts/.claude.md): the push is recorded PENDING,
 * audited, under the loan lock, BEFORE the provider is asked, and its checkout
 * id is written when the provider answers. One open push per loan at a time
 * (a push older than STK_PENDING_WINDOW_MS no longer blocks: the prompt has
 * expired on the phone). The result callback settles it
 * (lib/mobile-money/stk-result.ts). The simulated provider answers at once
 * with its own signed callback, delivered here in-process through the same
 * verification and ingest as the webhook.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { normalisePhone } from "@/lib/contact/identity"
import { lockLoanForUpdate } from "@/lib/loan/lock"
import { auditSettled, type MobileMoneyDb } from "./book"
import { ingestMobileMoneyCallback, type IngestOutcome } from "./c2b-ingest"
import { getMobileMoneyProvider } from "./registry"
import { msisdnLast4 } from "./types"

/** An STK prompt times out on the phone well inside this. */
export const STK_PENDING_WINDOW_MS = 3 * 60 * 1000

export type StkPushOutcome =
  | { ok: true; transactionId: string; status: IngestOutcome["outcome"] | "PENDING" }
  | { ok: false; reason: "INVALID_PHONE" | "REJECTED" | "PUSH_PENDING"; message: string }

/** A Kenyan mobile number as M-Pesa takes it (2547…, 2541…), or null. */
export function mpesaMsisdn(phone: string): string | null {
  const msisdn = normalisePhone(phone, "KE")
  return /^254\d{9}$/.test(msisdn) ? msisdn : null
}

export async function startStkPush(db: MobileMoneyDb, args: {
  tenantId: string
  providerId: string
  loan: { id: string; reference: string }
  /** cents, whole shillings */
  amountCents: number
  phone: string
  actorEmail: string
}): Promise<StkPushOutcome> {
  const { tenantId } = args
  const msisdn = mpesaMsisdn(args.phone)
  if (!msisdn) return { ok: false, reason: "INVALID_PHONE", message: "Enter a Kenyan mobile number, e.g. 0712 345 678" }
  // Throws MobileMoneyProviderError where the provider may not run (simulation forbidden).
  const provider = getMobileMoneyProvider(args.providerId)
  const simulated = provider.simulation() !== null

  const claim = await db.$transaction(async (tx) => {
    await lockLoanForUpdate(tx, args.loan.id)
    const open = await tx.mobileMoneyTransaction.findFirst({
      where: { tenantId, loanId: args.loan.id, status: "PENDING", createdAt: { gt: new Date(Date.now() - STK_PENDING_WINDOW_MS) } },
      select: { id: true },
    })
    if (open) return null
    const row = await tx.mobileMoneyTransaction.create({
      data: {
        tenantId, provider: provider.id, msisdnLast4: msisdnLast4(msisdn), billRef: args.loan.reference,
        amount: args.amountCents, status: "PENDING", loanId: args.loan.id, simulated,
      },
      select: { id: true },
    })
    await logAuditStrict({
      tenantId, userEmail: args.actorEmail, action: AuditAction.MOBILE_MONEY_STK_REQUESTED,
      entity: "MobileMoneyTransaction", entityId: row.id,
      newValue: { provider: provider.id, loanId: args.loan.id, amount: args.amountCents, simulated },
    }, tx)
    return row
  })
  if (!claim) {
    return { ok: false, reason: "PUSH_PENDING", message: "A payment request is already waiting on your phone. Complete or cancel it first." }
  }

  // An exception here leaves the claim PENDING: the prompt may have been sent, and
  // a result naming an unknown checkout id is kept UNMATCHED, never dropped.
  const result = await provider.requestStkPush({
    tenantId, msisdn, amountCents: args.amountCents, accountReference: args.loan.reference,
  })
  if (result.kind === "rejected") {
    await db.$transaction(async (tx) => {
      const cancelled = await tx.mobileMoneyTransaction.updateMany({
        where: { id: claim.id, tenantId, status: "PENDING" }, data: { status: "CANCELLED" },
      })
      if (cancelled.count === 1) {
        await auditSettled(tx, {
          tenantId, transactionId: claim.id, provider: provider.id, transId: null, amount: args.amountCents,
          loanId: args.loan.id, simulated, settled: { status: "CANCELLED", reason: result.reason },
        })
      }
    })
    return { ok: false, reason: "REJECTED", message: result.reason }
  }
  await db.mobileMoneyTransaction.updateMany({
    where: { id: claim.id, tenantId, status: "PENDING", checkoutRequestId: null },
    data: { checkoutRequestId: result.checkoutRequestId },
  })

  if (!result.callback) return { ok: true, transactionId: claim.id, status: "PENDING" }
  const callback = provider.parseCallback({ ...result.callback, tenantId })
  if (!callback) return { ok: true, transactionId: claim.id, status: "PENDING" }
  const settled = await ingestMobileMoneyCallback(db, { tenantId, provider, callback })
  return { ok: true, transactionId: claim.id, status: settled.outcome }
}
