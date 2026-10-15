/**
 * Retrying a payout that FAILED or was RETURNED (PR #89 round 1).
 *
 * A retry is a NEW attempt (attempt n+1, key disburse:<applicationId>:<n+1>),
 * created AWAITING_APPROVAL by the requester. It pays the borrower's CURRENT
 * banking profile, which must match a verified bank statement and carry a
 * passing AVS run after the attempt that failed. A second LOAN_ADMIN — not the
 * requester, not the disburser — approves it (-> PENDING, then sent through
 * the usual claim) or rejects it (-> CANCELLED, never sent). The database
 * refuses a second open attempt, a retry of an attempt that is not over, and
 * an approval by the wrong person (guardDisbursementPayout).
 */
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { prisma } from "@/lib/prisma"
import { findVerifiedBankStatementForMandate } from "@/lib/compliance/debit-mandate.server"
import { assertPayoutAvs, PayoutAvsError } from "./avs"
import { payoutIdempotencyKey } from "./disbursement"
import { getPayoutProvider } from "./registry"
import { isOver, type PayoutStatus } from "./state"
import { PayoutProviderError } from "./types"

export type RetryDb = Pick<typeof prisma,
  "disbursementPayout" | "disbursementReversal" | "loan" | "clientDocument" | "avsCheck" | "tenantConfig" | "auditLog" | "$transaction">

export type RetryResult = { ok: true; payoutId: string; status: PayoutStatus } | { ok: false; status: number; error: string }

const actorOf = (a: { id: string; email: string }) => ({ userId: a.id, userEmail: a.email })

export async function requestPayoutRetry(db: RetryDb, args: { tenantId: string; loanId: string; actor: { id: string; email: string } }): Promise<RetryResult> {
  const config = await db.tenantConfig.findUnique({ where: { tenantId: args.tenantId }, select: { payoutsEngineEnabled: true, payoutProvider: true } })
  if (config?.payoutsEngineEnabled !== true) return { ok: false, status: 409, error: "Payouts are turned off for this lender" }
  const loan = await db.loan.findFirst({
    where: { id: args.loanId, tenantId: args.tenantId },
    select: {
      id: true, status: true, applicationId: true,
      client: { select: { id: true, idNumber: true, firstName: true, lastName: true, bankName: true, bankBranchCode: true, bankAccountNumber: true, accountType: true } },
    },
  })
  if (!loan?.client) return { ok: false, status: 404, error: "Loan not found" }
  if (loan.status !== "ACTIVE" && loan.status !== "DEFAULTED") return { ok: false, status: 409, error: "Only an active loan's payout can be retried" }
  const last = await db.disbursementPayout.findFirst({ where: { tenantId: args.tenantId, loanId: loan.id }, orderBy: { attempt: "desc" } })
  if (!last || !isOver(last.status as PayoutStatus)) {
    return { ok: false, status: 409, error: "Only a failed, returned or rejected payout can be retried" }
  }
  const openReversal = await db.disbursementReversal.findFirst({ where: { tenantId: args.tenantId, loanId: loan.id, status: { not: "REJECTED" } }, select: { id: true } })
  if (openReversal) return { ok: false, status: 409, error: "A reversal of this disbursement is open; decide it first" }

  const c = loan.client
  if (!c.bankName || !c.bankBranchCode || !c.bankAccountNumber || (c.accountType !== "CHEQUE" && c.accountType !== "SAVINGS" && c.accountType !== "OTHER")) {
    return { ok: false, status: 422, error: "Capture the client's complete bank account first" }
  }
  const bankDetails = { bankName: c.bankName, branchCode: c.bankBranchCode, accountNumber: c.bankAccountNumber, accountType: c.accountType }
  const statement = await findVerifiedBankStatementForMandate(db as unknown as Parameters<typeof findVerifiedBankStatementForMandate>[0], {
    tenantId: args.tenantId, clientId: c.id, bankDetails,
  })
  if (!statement.ok) return { ok: false, status: 422, error: "The current bank account must match a verified bank statement" }

  let avs: { avsCheckId: string; simulated: boolean }
  let providerId: string
  try {
    avs = await assertPayoutAvs(db, {
      tenantId: args.tenantId, applicationId: loan.applicationId, client: c,
      account: { bankName: c.bankName, bankAccountNumber: c.bankAccountNumber, bankBranchCode: c.bankBranchCode, accountType: c.accountType },
      notBefore: last.resolvedAt ?? last.updatedAt,
    })
    providerId = getPayoutProvider(config.payoutProvider).id
  } catch (error) {
    if (error instanceof PayoutAvsError || error instanceof PayoutProviderError) return { ok: false, status: 422, error: error.message }
    throw error
  }

  const attempt = last.attempt + 1
  return db.$transaction(async (tx) => {
    const created = await tx.disbursementPayout.create({
      data: {
        tenantId: args.tenantId, applicationId: loan.applicationId, loanId: loan.id, attempt, retryOfId: last.id,
        provider: providerId, idempotencyKey: payoutIdempotencyKey(loan.applicationId, attempt),
        amountCents: last.amountCents, reference: last.reference,
        accountHolder: `${c.firstName} ${c.lastName}`.trim(), bankName: c.bankName!, branchCode: c.bankBranchCode!,
        accountNumber: c.bankAccountNumber!, accountType: c.accountType!,
        status: "AWAITING_APPROVAL", createdById: args.actor.id, requestedById: args.actor.id, disbursedById: last.disbursedById,
      },
      select: { id: true },
    })
    await logAuditStrict({
      tenantId: args.tenantId, ...actorOf(args.actor), action: AuditAction.PAYOUT_RETRY_REQUESTED,
      entity: "DisbursementPayout", entityId: created.id,
      newValue: { loanId: loan.id, attempt, retryOf: last.id, previousStatus: last.status, provider: providerId, avsCheckId: avs.avsCheckId, avsSimulated: avs.simulated, bankName: c.bankName },
    }, tx)
    return { ok: true as const, payoutId: created.id, status: "AWAITING_APPROVAL" as const }
  })
}

/** The second person's decision. An approval re-checks the AVS; the caller sends the payout after commit. */
export async function decidePayoutRetry(db: RetryDb, args: {
  tenantId: string
  payoutId: string
  approve: boolean
  note: string
  actor: { id: string; email: string }
}): Promise<RetryResult> {
  const p = await db.disbursementPayout.findFirst({ where: { id: args.payoutId, tenantId: args.tenantId } })
  if (!p || p.status !== "AWAITING_APPROVAL") return { ok: false, status: 409, error: "No retry of this payout is awaiting approval" }
  if (args.actor.id === p.requestedById || args.actor.id === p.disbursedById) {
    await logAuditStrict({
      tenantId: args.tenantId, ...actorOf(args.actor), action: AuditAction.PAYOUT_ACTION_REFUSED,
      entity: "DisbursementPayout", entityId: p.id, newValue: { action: args.approve ? "approve_retry" : "reject_retry", reason: "maker_checker" },
    }, db)
    return { ok: false, status: 403, error: "A second LOAN_ADMIN decides a retry: not whoever requested it or disbursed the loan" }
  }
  if (args.approve) {
    const loan = await db.loan.findFirst({
      where: { id: p.loanId, tenantId: args.tenantId },
      select: { client: { select: { id: true, idNumber: true, firstName: true, lastName: true } } },
    })
    const previous = p.retryOfId ? await db.disbursementPayout.findFirst({ where: { id: p.retryOfId, tenantId: args.tenantId } }) : null
    try {
      if (!loan?.client) throw new PayoutAvsError("Loan not found")
      await assertPayoutAvs(db, {
        tenantId: args.tenantId, applicationId: p.applicationId, client: loan.client,
        account: { bankName: p.bankName, bankAccountNumber: p.accountNumber, bankBranchCode: p.branchCode, accountType: p.accountType },
        notBefore: previous?.resolvedAt ?? previous?.updatedAt ?? null,
      })
    } catch (error) {
      if (error instanceof PayoutAvsError) return { ok: false, status: 422, error: error.message }
      throw error
    }
  }
  const now = new Date()
  const to = args.approve ? "PENDING" : "CANCELLED"
  return db.$transaction(async (tx) => {
    const moved = await tx.disbursementPayout.updateMany({
      where: { id: p.id, tenantId: args.tenantId, status: "AWAITING_APPROVAL" },
      data: args.approve
        ? { status: "PENDING", approvedById: args.actor.id, approvedAt: now }
        : { status: "CANCELLED", resolvedById: args.actor.id, resolvedAt: now, resolutionNote: args.note },
    })
    if (moved.count !== 1) return { ok: false as const, status: 409, error: "The retry changed; refresh and try again" }
    await logAuditStrict({
      tenantId: args.tenantId, ...actorOf(args.actor), action: AuditAction.PAYOUT_RETRY_DECIDED,
      entity: "DisbursementPayout", entityId: p.id,
      oldValue: { status: "AWAITING_APPROVAL" }, newValue: { status: to, approved: args.approve, note: args.note },
    }, tx)
    return { ok: true as const, payoutId: p.id, status: to as PayoutStatus }
  })
}
