/**
 * "Pay with M-Pesa": asks the provider to prompt the borrower's phone for a
 * payment to the lender's paybill, account = the loan reference, and records
 * the push PENDING (audited) until its result callback settles it
 * (lib/mobile-money/stk-result.ts). The simulated provider answers at once
 * with its own signed callback, which is delivered here in-process through the
 * same verification and ingest as the webhook.
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { normalisePhone } from "@/lib/contact/identity"
import { ingestMobileMoneyCallback, type IngestOutcome, type MobileMoneyDb } from "./c2b-ingest"
import { getMobileMoneyProvider } from "./registry"
import { msisdnLast4 } from "./types"

export type StkPushOutcome =
  | { ok: true; transactionId: string; status: IngestOutcome["outcome"] | "PENDING" }
  | { ok: false; reason: "INVALID_PHONE" | "REJECTED"; message: string }

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
  const msisdn = mpesaMsisdn(args.phone)
  if (!msisdn) return { ok: false, reason: "INVALID_PHONE", message: "Enter a Kenyan mobile number, e.g. 0712 345 678" }
  // Throws MobileMoneyProviderError where the provider may not run (simulation forbidden).
  const provider = getMobileMoneyProvider(args.providerId)
  const result = await provider.requestStkPush({
    tenantId: args.tenantId, msisdn, amountCents: args.amountCents, accountReference: args.loan.reference,
  })
  if (result.kind === "rejected") return { ok: false, reason: "REJECTED", message: result.reason }

  const simulated = provider.simulation() !== null
  const push = await db.$transaction(async (tx) => {
    const row = await tx.mobileMoneyTransaction.create({
      data: {
        tenantId: args.tenantId, provider: provider.id, checkoutRequestId: result.checkoutRequestId,
        msisdnLast4: msisdnLast4(msisdn), billRef: args.loan.reference, amount: args.amountCents,
        status: "PENDING", loanId: args.loan.id, simulated,
      },
      select: { id: true },
    })
    await logAuditStrict({
      tenantId: args.tenantId, userEmail: args.actorEmail, action: AuditAction.MOBILE_MONEY_STK_REQUESTED,
      entity: "MobileMoneyTransaction", entityId: row.id,
      newValue: { provider: provider.id, loanId: args.loan.id, amount: args.amountCents, simulated },
    }, tx)
    return row
  })

  if (!result.callback) return { ok: true, transactionId: push.id, status: "PENDING" }
  const callback = provider.parseCallback(result.callback)
  if (!callback) return { ok: true, transactionId: push.id, status: "PENDING" }
  const settled = await ingestMobileMoneyCallback(db, { tenantId: args.tenantId, provider, callback })
  return { ok: true, transactionId: push.id, status: settled.outcome }
}
