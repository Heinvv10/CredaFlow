/**
 * The disburse route's seam into payouts (TenantConfig.payoutsEngineEnabled).
 *
 * Design: the loan is booked exactly as before — the application becomes
 * DISBURSED and the loan ACTIVE in the disburse transaction, where every
 * database disbursement guard runs — and the provider payout is a tracked
 * obligation beside it. The payout row is created in that same transaction,
 * keyed `disburse:<applicationId>` (unique, DB-enforced), so a second
 * disbursement of the application cannot commit a second payout. The provider
 * is called only after the commit, through the claim in dispatch.ts.
 *
 * Deferring DISBURSED until the provider confirms payment was rejected: the
 * guards that refuse a disbursement without its evidence fire on that status
 * write, and moving it to an unauthenticated webhook would split a
 * SERIALIZABLE transaction that re-verifies a dozen kinds of evidence.
 */
import { AuditAction } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"
import { dispatchPayout, type Actor, type PayoutDb } from "./dispatch"
import { getPayoutProvider } from "./registry"
import type { PayoutStatus } from "./state"
import { PayoutProviderError } from "./types"

export interface DisbursementPayoutInput {
  tenantId: string
  applicationId: string
  loanId: string
  /** TenantConfig.payoutProvider; must be an implemented adapter. */
  providerId: string | null
  amountCents: number
  reference: string
  /** The verified banking profile the route resolved; nullable as resolved, refused if incomplete. */
  beneficiary: { accountHolder: string; bankName: string; branchCode: string | null; accountNumber: string; accountType: string | null }
  user: { id: string; email: string }
  /** The AVS check that verified this account (lib/payouts/avs.ts), recorded in the audit row. */
  avs: { avsCheckId: string; simulated: boolean }
}

export function payoutIdempotencyKey(applicationId: string): string {
  return `disburse:${applicationId}`
}

/**
 * Inside the disburse transaction. Throws PayoutProviderError when the
 * tenant's channel cannot pay, which rolls the whole disbursement back.
 */
export async function createDisbursementPayout(
  tx: Pick<typeof prisma, "disbursementPayout" | "auditLog">,
  input: DisbursementPayoutInput,
): Promise<{ id: string }> {
  const provider = getPayoutProvider(input.providerId)
  const { accountHolder, bankName, branchCode, accountNumber, accountType } = input.beneficiary
  if (!accountHolder || !bankName || !branchCode || !accountNumber || !accountType) {
    throw new PayoutProviderError("INCOMPLETE_BENEFICIARY", "the verified bank account is missing its holder, bank, branch code, number or type")
  }
  const payout = await tx.disbursementPayout.create({
    data: {
      tenantId: input.tenantId,
      applicationId: input.applicationId,
      loanId: input.loanId,
      provider: provider.id,
      idempotencyKey: payoutIdempotencyKey(input.applicationId),
      amountCents: input.amountCents,
      reference: input.reference,
      accountHolder, bankName, branchCode, accountNumber, accountType,
      createdById: input.user.id,
    },
    select: { id: true },
  })
  await tx.auditLog.create({
    data: {
      tenantId: input.tenantId,
      userId: input.user.id,
      userEmail: input.user.email,
      action: AuditAction.PAYOUT_CREATED,
      entity: "DisbursementPayout",
      entityId: payout.id,
      // The account number stays on the payout row; the audit names the bank only.
      newValue: {
        applicationId: input.applicationId, loanId: input.loanId, provider: provider.id,
        amountCents: input.amountCents, reference: input.reference, bankName: input.beneficiary.bankName,
        avsCheckId: input.avs.avsCheckId, avsSimulated: input.avs.simulated,
      },
    },
  })
  return payout
}

/**
 * After the disburse transaction commits. Never throws: the loan is booked,
 * so a failure here must not read as a failed disbursement. Whatever happened
 * is on the payout row (and its audit), shown on the loan page.
 */
export async function sendDisbursementPayout(db: PayoutDb, args: { tenantId: string; payoutId: string; actor: Actor }): Promise<{ id: string; status: PayoutStatus | "UNKNOWN" }> {
  try {
    const outcome = await dispatchPayout(db, args)
    if (outcome.kind === "sent") return { id: args.payoutId, status: outcome.status }
    if (outcome.kind === "not_sendable") {
      console.error("[payouts] payout left unsent:", { payoutId: args.payoutId, reason: outcome.reason })
      return { id: args.payoutId, status: "PENDING" }
    }
    return { id: args.payoutId, status: outcome.status ?? "UNKNOWN" }
  } catch (error) {
    console.error("[payouts] dispatch failed after the disbursement committed:", { payoutId: args.payoutId, error: error instanceof Error ? error.name : "unknown" })
    return { id: args.payoutId, status: "UNKNOWN" }
  }
}
