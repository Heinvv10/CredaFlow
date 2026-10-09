// The PLAIN-SPACE rand formatter. Every money string in this file lands in a
// server log — a generic throw from here becomes a 500 with
// a generic body, so none of it reaches a rendered page — and a non-breaking
// space in a log line is a grep and copy-paste hazard.
// lib/loan-calculator keeps the NBSP one for the UI.
import { formatZAR } from "@/lib/utils"
import { computeCommissionCents, resolveEffectiveBps } from "./commission"

const normaliseName = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ")
const normaliseEmail = (s: string) => s.trim().toLowerCase()

// SA numbers reach us as 0821234567, +27821234567, or with spaces. Comparing the
// last nine digits makes those three the same person without needing a library.
function normalisePhone(s: string): string | null {
  const digits = s.replace(/\D/g, "")
  return digits.length >= 9 ? digits.slice(-9) : null
}

/**
 * Loan statuses a backfill will pay commission on.
 *
 * Deliberately an ALLOW-list. Commission is clawed back on default
 * (`reverseReferralCommissionForLoan`), so accruing on a DEFAULTED or
 * WRITTEN_OFF loan would put a row in the LOAN_ADMIN approval queue that
 * someone could approve into a real payment on money that was never repaid.
 * A status added to the schema later lands outside this list and is skipped
 * until a human decides it belongs — a deny-list would silently include it.
 *
 * RESTRUCTURED is listed but nothing in the codebase currently writes it, so it
 * is unreachable today; a restructured loan is still a disbursed loan the agent
 * referred, so excluding it would under-pay if restructuring ever ships.
 */
export const BACKFILL_ELIGIBLE_LOAN_STATUSES = new Set(["ACTIVE", "COMPLETED", "RESTRUCTURED"])

export type BackfillCandidate = {
  loanId: string
  loanReference: string
  loanStatus: string
  loanCreatedAt: string
  principalCents: number
  clientId: string
  clientName: string
  clientPhone: string | null
  clientEmail: string | null
  /** The agent the accrual will be written FOR. Null only when the code could
   *  not be resolved, which planCommissionBackfill already excludes as
   *  CODE_NOT_ACTIVE — so it is never null on an accrue entry. */
  agentId: string | null
  agentName: string
  agentPhone: string | null
  agentEmail: string | null
  agentStatus: string
  agentCommissionBps: number | null
  codeValue: string
  codeStatus: string
}

/**
 * Is the borrower the agent?
 *
 * Name equality alone is trivially evaded — a middle name, a married name or a
 * changed spelling all defeat it — so phone and email are checked too. Those are
 * only compared when the agent actually has one on file; an agent with no
 * contact details must not match every client.
 *
 * Still a heuristic, not proof. There is no shared stable identifier between
 * ReferralAgent and Client (the agent record carries no ID number), so a
 * determined evasion remains possible. Exclusions are therefore reported rather
 * than applied silently.
 */
export function isSelfReferral(c: BackfillCandidate): boolean {
  if (normaliseName(c.clientName) === normaliseName(c.agentName)) return true

  if (c.agentPhone && c.clientPhone) {
    const a = normalisePhone(c.agentPhone)
    const b = normalisePhone(c.clientPhone)
    if (a && b && a === b) return true
  }

  if (c.agentEmail && c.clientEmail) {
    if (normaliseEmail(c.agentEmail) === normaliseEmail(c.clientEmail)) return true
  }

  return false
}

export type BackfillSkipReason =
  | "INELIGIBLE_LOAN_STATUS"
  | "AGENT_NOT_ACTIVE"
  | "CODE_NOT_ACTIVE"
  | "SELF_REFERRAL"
  | "ZERO_RATE"

export type BackfillPlan = {
  accrue: (BackfillCandidate & { bps: number; commissionCents: number })[]
  skipped: (BackfillCandidate & { reason: BackfillSkipReason })[]
}

/**
 * Decide, for each already-disbursed referred loan, whether a commission accrual
 * should be written and what it is worth. Pure — no I/O — so the money arithmetic
 * and the exclusion rules are testable without a database.
 *
 * Mirrors the gates in `recordDisbursementCommission`, which is what actually
 * performs the write. This function exists to make the decision *visible* in a
 * dry run before any of it is committed.
 */
export function planCommissionBackfill(
  candidates: BackfillCandidate[],
  tenantCommissionBps: number,
): BackfillPlan {
  const plan: BackfillPlan = { accrue: [], skipped: [] }

  for (const c of candidates) {
    if (!BACKFILL_ELIGIBLE_LOAN_STATUSES.has(c.loanStatus)) {
      plan.skipped.push({ ...c, reason: "INELIGIBLE_LOAN_STATUS" })
      continue
    }
    // An agent does not earn commission on their own loan (Hein, 2026-08-06).
    // Reported ahead of agent/code status and the rate because it is the most
    // DURABLE blocker: reactivating a suspended agent or setting a rate will
    // never make a self-referral payable, so leading with either of those sends
    // an operator down a road that does not end in payment. A heuristic, so it
    // lands in `skipped` and is printed with its reason — a false positive stays
    // visible to whoever signs off instead of quietly under-paying an agent.
    if (isSelfReferral(c)) {
      plan.skipped.push({ ...c, reason: "SELF_REFERRAL" })
      continue
    }
    if (c.agentStatus !== "ACTIVE") {
      plan.skipped.push({ ...c, reason: "AGENT_NOT_ACTIVE" })
      continue
    }
    if (c.codeStatus !== "ACTIVE") {
      plan.skipped.push({ ...c, reason: "CODE_NOT_ACTIVE" })
      continue
    }

    // Same precedence as live accrual: an agent override of 0 means "this agent
    // earns nothing" and must not fall through to the tenant default.
    const bps = resolveEffectiveBps(
      { commissionBps: c.agentCommissionBps },
      { referralCommissionBps: tenantCommissionBps },
    )
    if (bps <= 0) {
      plan.skipped.push({ ...c, reason: "ZERO_RATE" })
      continue
    }

    plan.accrue.push({ ...c, bps, commissionCents: computeCommissionCents(c.principalCents, bps) })
  }

  return plan
}

type BackfillTxClient = {
  referralEvent: { findFirst(args: unknown): Promise<unknown> }
  auditLog: { create(args: unknown): Promise<unknown> }
}

export type PlannedAccrual = {
  tenantId: string
  loanId: string
  clientId: string
  loanReference: string
  agentId: string | null
  agentName: string
  principalCents: number
  bps: number
  commissionCents: number
}

/**
 * Write one backfilled accrual and its audit row inside a caller-supplied
 * transaction.
 *
 * `recordAccrual` is the PRODUCTION accrual function, injected rather than
 * imported here so this stays unit-testable and so the backfill cannot drift
 * from the gates the live disbursement path applies.
 *
 * Throws — rolling the caller's transaction back — if the accrual did not
 * actually write, or wrote an amount other than the one an operator signed off
 * on in the dry run. Recording a figure the ledger does not contain would put a
 * false number into a compliance trail on the very path meant to detect the
 * disagreement, so this refuses instead. A rollback is safe: the accrual is
 * idempotent, so a corrected re-run picks the loan up again.
 */
export async function applyBackfillAccrual<Tx extends BackfillTxClient>(
  tx: Tx,
  planned: PlannedAccrual,
  approvedBy: string,
  // Generic over the transaction type so the caller's real Prisma client — which
  // also satisfies recordDisbursementCommission's own client contract — flows
  // through unchanged. A fixed parameter type here would force a cast at the one
  // call site that touches money.
  recordAccrual: (tx: Tx, opts: {
    tenantId: string; loanId: string; clientId: string; principalCents: number
    supersedeReversedPriors?: boolean
  }) => Promise<void>,
  // Defaults reproduce the rate-was-zero backfill byte-for-byte; the manual
  // re-attribution path (lib/referral-agents/retro-attribution.ts) is the only caller
  // that overrides them. Its provenance differs — a re-attribution is not a
  // backfill — and it has already reversed a prior row for this loan inside the
  // same transaction, which BOTH the accrual and the verification below must
  // look past or they would find the reversed row and roll a correct write back.
  options: {
    supersedeReversedPriors?: boolean
    auditAction?: string
    reason?: string
    /** CONVERTED rows for this loan the caller had already seen when it built
     *  the plan. Excluded from the verification so it can only be satisfied by a
     *  row this transaction actually created — the caller already holds these,
     *  so proving newness costs no extra query. */
    knownPriorEventIds?: string[]
    /** Staff id when a person triggered this. The script has no session, so the
     *  default stays null and `approvedBy` is the only trace. */
    userId?: string | null
  } = {},
): Promise<{ eventId: string; commissionCents: number }> {
  // Verifying against a row this write did not create is the one failure this
  // function exists to prevent, and it cannot be done without knowing the payee.
  if (planned.agentId === null) {
    throw new Error(`${planned.loanReference}: cannot verify an accrual that names no agent`)
  }

  await recordAccrual(tx, {
    tenantId: planned.tenantId,
    loanId: planned.loanId,
    clientId: planned.clientId,
    principalCents: planned.principalCents,
    ...(options.supersedeReversedPriors ? { supersedeReversedPriors: true } : {}),
  })

  // recordAccrual returns void whether it wrote or declined its own gates.
  // Confirm the row exists rather than trusting silence.
  const event = (await tx.referralEvent.findFirst({
    where: {
      tenantId: planned.tenantId,
      eventType: "CONVERTED",
      metadata: { path: ["loanId"], equals: planned.loanId },
      // Scoped to the PLANNED agent. Matching on loanId and amount alone let
      // another agent's row satisfy this check whenever the two shared a bps,
      // and the audit row then named an event this transaction never wrote.
      agentId: planned.agentId,
      ...(options.knownPriorEventIds?.length
        ? { id: { notIn: options.knownPriorEventIds } }
        : {}),
      ...(options.supersedeReversedPriors ? { commissionStatus: { not: "REVERSED" } } : {}),
    },
    select: { id: true, commissionCents: true },
  })) as { id: string; commissionCents: number | null } | null

  if (!event) {
    throw new Error(`${planned.loanReference}: accrual declined by recordDisbursementCommission`)
  }
  if (event.commissionCents !== planned.commissionCents) {
    throw new Error(
      `${planned.loanReference}: accrual wrote ${formatZAR(event.commissionCents ?? 0)} but the approved plan said ` +
      `${formatZAR(planned.commissionCents)} — rate changed mid-run? Rolled back; re-run the dry run.`,
    )
  }

  await tx.auditLog.create({
    data: {
      tenantId: planned.tenantId,
      userId: options.userId ?? null,
      userEmail: approvedBy,
      action: options.auditAction ?? "REFERRAL_COMMISSION_BACKFILLED",
      entity: "ReferralEvent",
      entityId: event.id,
      newValue: {
        loanId: planned.loanId,
        loanReference: planned.loanReference,
        agentName: planned.agentName,
        principalCents: planned.principalCents,
        bps: planned.bps,
        commissionCents: event.commissionCents,
        reason: options.reason ?? "Backfill of accrual missed while the commission rate was 0",
        approvedBy,
      },
    },
  })

  return { eventId: event.id, commissionCents: event.commissionCents }
}

export type BackfillOutcome = "ACCRUE" | "RATE_OFF" | "NOTHING_ELIGIBLE"

/**
 * Classify an empty plan. "Nothing to do" has two very different causes and the
 * operator needs to be told which:
 *
 *   RATE_OFF          — the rate is 0, so go and set it. Actionable, an error.
 *   NOTHING_ELIGIBLE  — the rate is fine; the remaining loans are defaulted or
 *                       already accrued. Nothing to fix, a normal exit.
 *
 * Collapsing the two sends someone to change a setting that is already correct.
 */
export function backfillOutcome(plan: BackfillPlan): BackfillOutcome {
  if (plan.accrue.length > 0) return "ACCRUE"
  return plan.skipped.some((s) => s.reason === "ZERO_RATE") ? "RATE_OFF" : "NOTHING_ELIGIBLE"
}
