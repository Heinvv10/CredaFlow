/**
 * Provider conflicts: a provider (webhook or status query) reports money
 * moving — PAID or RETURNED — for an attempt that is already FAILED or
 * CANCELLED. The state machine will not apply it, but it must not vanish
 * either: the report is recorded on the attempt, audited, shown as a review
 * item, and blocks any retry, reversal or send on the loan (code and
 * database) until a second LOAN_ADMIN — not the disburser, requester or
 * approver — resolves it: "not_paid" (the provider was wrong; the attempt
 * stays as it was) or "paid" (the money did go out: the attempt becomes PAID
 * at the value date given). On a loan whose disbursement was already reversed
 * (CANCELLED) "paid" is refused, here and in the database: the loan is not
 * reinstated, and the money that went out is "recovery" — a
 * PayoutRecoveryCase (lib/payouts/recovery.ts) opened at the value date given.
 *
 * Every report on an attempt already over is audited, with what became of it
 * (breaker re-attack, PR #89 round 3):
 *  - "stale": SUBMITTED/PROCESSING says nothing about money; never stored, so
 *    it cannot mask a later PAID (PAYOUT_PROVIDER_REPORT_IGNORED);
 *  - "recorded": the first PAID/RETURNED;
 *  - "strengthened": a stronger report (PAID > RETURNED) replaces an
 *    unresolved one;
 *  - "returned_after_paid": a RETURNED later (by event time) than an
 *    unresolved PAID, or a PAID earlier than an unresolved RETURNED, is
 *    stored as PAID_THEN_RETURNED (nets to not paid; never paid or recovered,
 *    and nothing overwrites it);
 *  - "reopened": any new PAID/RETURNED event (a new event id, or a status
 *    query) after the conflict was resolved not paid clears the resolution
 *    and blocks again, whatever its event time (the time only decides the
 *    state stored);
 *  - "duplicate": the provider's event id was seen before for this attempt
 *    (a redelivery or replay); nothing changes;
 *  - "rejected": the database refused it (a rule the code did not foresee):
 *    nothing is stored, not even the event, so a redelivery is tried again;
 *    audited (PAYOUT_PROVIDER_REPORT_REJECTED), logged and listed on the
 *    outstanding-payouts queue, never thrown at a webhook;
 *  - "dropped": weaker than the unresolved report, the attempt is no longer
 *    over, or the money is already a recovery case.
 *
 * Every report not applied (stale, dropped, rejected, or a late report on a
 * settled attempt) is listed for staff (lib/payouts/unapplied-reports.ts).
 * The provider's event time is capped at receipt; receipt and resolution
 * times come from the database clock (dbClock).
 */
import type { DisbursementPayout } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import type { Actor, PayoutDb } from "./dispatch"
import { dbClock, lockLoanForPayout, raceRefusal } from "./loan-lock"
import { openRecoveryCase } from "./recovery"
import type { PayoutStatus } from "./state"
import type { ProviderPayoutState } from "./types"

/** Attempt states a later report may contradict. */
export const CONFLICTABLE: readonly PayoutStatus[] = ["FAILED", "CANCELLED"]

export type ReportOutcome = "stale" | "duplicate" | "recorded" | "strengthened" | "returned_after_paid" | "reopened" | "dropped" | "rejected"
/** The provider's event behind a report: its id (a redelivery repeats it) and when it says it happened. */
export interface ProviderEvent { id: string | null; at: Date | null }

/** Paid, then returned: the money went and came back. */
export const PAID_THEN_RETURNED = "PAID_THEN_RETURNED"
const STRENGTH: Partial<Record<string, number>> = { [PAID_THEN_RETURNED]: 5, PAID: 4, RETURNED: 3, PROCESSING: 2, SUBMITTED: 1 }
const strength = (state: string | null) => (state ? STRENGTH[state] ?? 0 : 0)

/**
 * The state to store when `next` (at `nextAt`) meets the stored `prev` (at
 * `prevAt`), by the provider's event times; null = `prev` stands. A RETURNED
 * after a PAID, or a PAID before a RETURNED, is paid-then-returned.
 */
function combine(prev: string | null, prevAt: Date | null, next: string, nextAt: Date): string | null {
  if (!prev) return next
  const later = !prevAt || nextAt.getTime() >= prevAt.getTime()
  if (prev === "PAID" && next === "RETURNED") return later ? PAID_THEN_RETURNED : null
  if (prev === "RETURNED" && next === "PAID") return later ? "PAID" : PAID_THEN_RETURNED
  return strength(next) > strength(prev) ? next : null
}

export async function recordProviderConflict(db: PayoutDb, args: {
  tenantId: string
  payout: Pick<DisbursementPayout, "id" | "status">
  state: ProviderPayoutState
  reason?: string
  source: string
  actor: Actor
  event?: ProviderEvent
}): Promise<ReportOutcome> {
  const detail = `${args.source} reported ${args.state} after the attempt was ${args.payout.status}${args.reason ? `: ${args.reason}` : ""}`.slice(0, 500)
  const audit = (tx: Parameters<Parameters<PayoutDb["$transaction"]>[0]>[0], outcome: ReportOutcome, extra: Record<string, unknown> = {}) => logAuditStrict({
    tenantId: args.tenantId, userId: args.actor.id ?? undefined, userEmail: args.actor.email,
    action: outcome === "stale" ? AuditAction.PAYOUT_PROVIDER_REPORT_IGNORED : AuditAction.PAYOUT_PROVIDER_CONFLICT,
    entity: "DisbursementPayout", entityId: args.payout.id,
    newValue: { status: args.payout.status, reported: args.state, source: args.source, detail, outcome, ...extra },
  }, tx)
  try {
    return await recordInTx(db, args, detail, audit)
  } catch (error) {
    const reason = error instanceof Error ? /(Payout guard: [^\n"]+)/.exec(error.message)?.[1]?.replace(/\\+$/, "") : undefined
    if (!reason) throw error
    console.error("Provider report refused by the payout guard:", args.payout.id, args.state)
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id ?? undefined, userEmail: args.actor.email,
      action: AuditAction.PAYOUT_PROVIDER_REPORT_REJECTED, entity: "DisbursementPayout", entityId: args.payout.id,
      newValue: { reported: args.state, source: args.source, detail, eventId: args.event?.id ?? null, reason },
    }, db)
    return "rejected"
  }
}

type Audit = (tx: Parameters<Parameters<PayoutDb["$transaction"]>[0]>[0], outcome: ReportOutcome, extra?: Record<string, unknown>) => Promise<unknown>

async function recordInTx(db: PayoutDb, args: Parameters<typeof recordProviderConflict>[1], detail: string, audit: Audit): Promise<ReportOutcome> {
  return db.$transaction(async (tx) => {
    // The loan lock first, like a retry approval or a claim to send.
    const owner = await tx.disbursementPayout.findFirst({ where: { id: args.payout.id, tenantId: args.tenantId }, select: { loanId: true } })
    if (owner) await lockLoanForPayout(tx, args.tenantId, owner.loanId)
    const receivedAt = await dbClock(tx)
    // The provider's event time, never later than receipt (a skewed or forged future time cannot win).
    const eventAt = args.event?.at && args.event.at.getTime() < receivedAt.getTime() ? args.event.at : receivedAt
    const eventId = args.event?.id ?? null
    if (eventId && owner) {
      const kept = await tx.payoutProviderEvent.createMany({
        data: [{ tenantId: args.tenantId, payoutId: args.payout.id, eventId, state: args.state, eventAt: args.event?.at ?? null, source: args.source }],
        skipDuplicates: true,
      })
      if (kept.count === 0) {
        await audit(tx, "duplicate", { eventId })
        return "duplicate"
      }
    }
    if (args.state !== "PAID" && args.state !== "RETURNED") {
      await audit(tx, "stale", { eventId })
      return "stale"
    }
    const row = await tx.disbursementPayout.findFirst({
      where: { id: args.payout.id, tenantId: args.tenantId },
      select: { status: true, providerConflictState: true, providerConflictAt: true, providerConflictEventAt: true, conflictResolvedAt: true, recoveryCase: { select: { id: true } } },
    })
    let outcome: ReportOutcome = "dropped"
    let data: Record<string, unknown> | null = null
    if (row && CONFLICTABLE.includes(row.status as PayoutStatus)) {
      // Stamped under the loan lock: after any resolution that committed while this report waited.
      const reported = { providerConflictState: args.state, providerConflictAt: receivedAt, providerConflictDetail: detail, providerConflictEventId: eventId, providerConflictEventAt: eventAt }
      const next = combine(row.providerConflictState, row.providerConflictEventAt ?? row.providerConflictAt, args.state, eventAt)
      const stated = next === PAID_THEN_RETURNED
        ? { ...reported, providerConflictState: PAID_THEN_RETURNED, providerConflictDetail: `${detail} (paid, then returned)`.slice(0, 500) }
        : next ? { ...reported, providerConflictState: next } : null
      if (!row.providerConflictAt) [outcome, data] = ["recorded", reported]
      else if (!row.conflictResolvedAt) {
        if (stated) [outcome, data] = [next === PAID_THEN_RETURNED ? "returned_after_paid" : "strengthened", stated]
      } else if (!row.recoveryCase) {
        // A new event reopens whatever its time; its time only decides the state kept.
        [outcome, data] = ["reopened", { ...(stated ?? { ...reported, providerConflictState: row.providerConflictState }), conflictResolvedAt: null, conflictResolvedById: null, conflictResolutionNote: null }]
      }
    }
    if (data && row) {
      const moved = await tx.disbursementPayout.updateMany({
        where: { id: args.payout.id, tenantId: args.tenantId, status: row.status, providerConflictAt: row.providerConflictAt, conflictResolvedAt: row.conflictResolvedAt },
        data,
      })
      if (moved.count !== 1) outcome = "dropped"
    }
    await audit(tx, outcome, { previous: row?.providerConflictState ?? null, previouslyResolved: Boolean(row?.conflictResolvedAt), eventId, eventAt: eventAt.toISOString() })
    return outcome
  })
}

export type ConflictOutcome = "not_paid" | "paid" | "recovery"
/** The provider report a staff decision was made on. */
export interface SeenConflict { state: string; at: Date }

const REPORTED_AGAIN = (now: string | null) => `The provider has reported again since this was loaded (now ${now ?? "nothing"}); review the latest report and decide again`

const REVERSED_PAID = "This loan's disbursement was reversed, so the attempt is not resolved as paid and the loan is not reinstated: open a recovery case for the money instead"
const NOT_REVERSED = "A recovery case is for money paid out on a reversed loan; this loan was not reversed"

export async function resolveProviderConflict(db: PayoutDb, args: {
  tenantId: string
  payout: DisbursementPayout
  outcome: ConflictOutcome
  note: string
  paidAt: Date | null
  seen?: SeenConflict
  actor: Actor & { id: string }
}): Promise<{ ok: true; status: PayoutStatus } | { ok: false; status: number; error: string }> {
  const p = args.payout
  if (!p.providerConflictAt || p.conflictResolvedAt) return { ok: false, status: 409, error: "This payout has no provider report awaiting resolution" }
  // A decision stands only for the report it was made on (scan, round 3): a
  // stronger or newer report since then is decided afresh.
  const seen: SeenConflict = args.seen ?? { state: p.providerConflictState ?? "", at: p.providerConflictAt }
  if (seen.state !== p.providerConflictState || seen.at.getTime() !== p.providerConflictAt.getTime()) {
    return { ok: false, status: 409, error: REPORTED_AGAIN(p.providerConflictState) }
  }
  if ([p.disbursedById, p.createdById, p.approvedById].includes(args.actor.id)) {
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
      action: AuditAction.PAYOUT_ACTION_REFUSED, entity: "DisbursementPayout", entityId: p.id,
      newValue: { action: "resolve_conflict", reason: "maker_checker" },
    }, db)
    return { ok: false, status: 403, error: "Another LOAN_ADMIN must resolve this: you disbursed the loan, or requested or approved this attempt" }
  }
  if (args.outcome !== "not_paid" && p.providerConflictState !== "PAID") {
    return { ok: false, status: 422, error: "The provider did not report this attempt paid" }
  }
  const loan = await db.loan.findFirst({ where: { id: p.loanId, tenantId: args.tenantId }, select: { status: true } })
  if (args.outcome === "paid" && loan?.status === "CANCELLED") return { ok: false, status: 409, error: REVERSED_PAID }
  if (args.outcome === "recovery" && loan?.status !== "CANCELLED") return { ok: false, status: 409, error: NOT_REVERSED }
  if (args.outcome === "paid") {
    const other = await db.disbursementPayout.findFirst({
      where: { tenantId: args.tenantId, applicationId: p.applicationId, id: { not: p.id }, status: { notIn: ["FAILED", "RETURNED", "CANCELLED"] } },
      select: { attempt: true, status: true },
    })
    if (other) {
      return { ok: false, status: 409, error: `Attempt ${other.attempt} is ${other.status}: if this one paid too, another attempt sent the money twice; recover it (returned) before resolving this as paid` }
    }
  }
  const now = new Date()
  const to: PayoutStatus = args.outcome === "paid" ? "PAID" : (p.status as PayoutStatus)
  try {
  return await db.$transaction(async (tx) => {
    const locked = await lockLoanForPayout(tx, args.tenantId, p.loanId)
    // The database's clock, like report receipt: a later report must be newer than this.
    const resolvedAt = await dbClock(tx)
    // Re-read under the lock: a reversal approved meanwhile changes the answer.
    if (args.outcome === "paid" && locked?.status === "CANCELLED") return { ok: false as const, status: 409, error: REVERSED_PAID }
    if (args.outcome === "recovery" && locked?.status !== "CANCELLED") return { ok: false as const, status: 409, error: NOT_REVERSED }
    const moved = await tx.disbursementPayout.updateMany({
      // Pinned to the report decided on, under the loan lock every report write also takes.
      where: { id: p.id, tenantId: args.tenantId, status: p.status, conflictResolvedAt: null, providerConflictState: seen.state, providerConflictAt: seen.at },
      data: {
        conflictResolvedAt: resolvedAt, conflictResolvedById: args.actor.id, conflictResolutionNote: args.note,
        ...(args.outcome === "paid" ? { status: "PAID", paidAt: args.paidAt ?? now, resolvedAt: now } : {}),
      },
    })
    if (moved.count !== 1) {
      const now = await tx.disbursementPayout.findFirst({ where: { id: p.id, tenantId: args.tenantId }, select: { providerConflictState: true } })
      return { ok: false as const, status: 409, error: REPORTED_AGAIN(now?.providerConflictState ?? null) }
    }
    const recovery = args.outcome === "recovery"
      ? await openRecoveryCase(tx, { tenantId: args.tenantId, payout: p, paidAt: args.paidAt ?? p.providerConflictAt ?? now, note: args.note, actor: args.actor })
      : null
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
      action: AuditAction.PAYOUT_PROVIDER_CONFLICT_RESOLVED, entity: "DisbursementPayout", entityId: p.id,
      oldValue: { status: p.status, reported: p.providerConflictState },
      newValue: { outcome: args.outcome, status: to, note: args.note, ...(args.outcome === "paid" ? { paidAt: (args.paidAt ?? now).toISOString() } : {}), ...(recovery ? { recoveryCaseId: recovery.id } : {}) },
    }, tx)
    return { ok: true as const, status: to }
  })
  } catch (error) {
    const refusal = raceRefusal(error)
    if (refusal) return { ...refusal, error: `Another attempt of this payout is paid or in flight. ${refusal.error}` }
    throw error
  }
}
