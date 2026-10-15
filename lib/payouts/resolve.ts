/**
 * Everything that moves a payout after it was sent: provider results (a
 * webhook or a status query) and staff actions. None of them sends money
 * again; "send" only dispatches a payout that was never claimed (PENDING).
 */
import type { DisbursementPayout } from "@prisma/client"
import { dispatchPayout, transitionPayout, type Actor, type DispatchOutcome, type PayoutDb } from "./dispatch"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { sastCalendarDate } from "@/lib/date/sast"
import { CONFLICTABLE, recordProviderConflict, resolveProviderConflict, type ConflictOutcome, type ReportOutcome, type SeenConflict } from "./conflicts"
import { findPayoutProvider } from "./registry"
import { nextFromProvider, type PayoutStatus } from "./state"
import type { PayoutNotification, ProviderPayoutState } from "./types"

/** A claim older than this with no recorded answer is a question for a person. */
export const STALE_SUBMITTING_MS = 10 * 60 * 1000

export type ResolveAction =
  | { action: "send" }
  | { action: "check" }
  | { action: "confirm_paid"; note: string; providerReference?: string | null; paidAt?: Date | null }
  | { action: "confirm_failed"; note: string }
  // `seen`: the report the decision was made on. Required from staff (the
  // API); without it the report as loaded here is pinned.
  | { action: "resolve_conflict"; outcome: ConflictOutcome; note: string; paidAt?: Date | null; seen?: SeenConflict }

export type ResolveResult =
  | { ok: true; status: PayoutStatus; changed: boolean; dispatch?: DispatchOutcome }
  | { ok: false; status: number; error: string }

const CONFIRMABLE: readonly PayoutStatus[] = ["NEEDS_REVIEW", "SUBMITTED", "PROCESSING"]

/** A bank value date: yyyy-mm-dd or ISO, not in the future. Undefined when absent, null when invalid. */
export function valueDate(value: unknown, now = new Date()): Date | undefined | null {
  if (value === undefined || value === null || value === "") return undefined
  if (typeof value !== "string") return null
  const at = new Date(value.length === 10 ? `${value}T12:00:00+02:00` : value)
  if (Number.isNaN(at.getTime())) return null
  // A date-only value is stamped at SAST noon; today's, given before noon, is now.
  if (value.length === 10 && value === sastCalendarDate(now) && at.getTime() > now.getTime()) return now
  return at.getTime() > now.getTime() ? null : at
}

export function parseResolveAction(body: unknown): ResolveAction | null {
  const b = (body ?? {}) as Record<string, unknown>
  const note = typeof b.note === "string" ? b.note.trim() : ""
  const paidAt = valueDate(b.paidAt)
  if (paidAt === null) return null
  switch (b.action) {
    case "send":
    case "check":
      return { action: b.action }
    case "confirm_paid":
      if (note.length < 5) return null
      return { action: "confirm_paid", note: note.slice(0, 1000), paidAt: paidAt ?? null, providerReference: typeof b.providerReference === "string" ? b.providerReference.trim().slice(0, 120) || null : null }
    case "confirm_failed":
      if (note.length < 5) return null
      return { action: "confirm_failed", note: note.slice(0, 1000) }
    case "resolve_conflict": {
      if (note.length < 5 || (b.outcome !== "paid" && b.outcome !== "not_paid" && b.outcome !== "recovery")) return null
      // The decision applies only to the report the person was looking at.
      const seenAt = typeof b.conflictAt === "string" ? new Date(b.conflictAt) : null
      if (typeof b.conflictState !== "string" || !seenAt || Number.isNaN(seenAt.getTime())) return null
      return { action: "resolve_conflict", outcome: b.outcome, note: note.slice(0, 1000), paidAt: paidAt ?? null, seen: { state: b.conflictState, at: seenAt } }
    }
    default:
      return null
  }
}

/** Applies a provider-reported state; a stale or repeated report changes nothing. */
export async function applyProviderState(db: PayoutDb, args: {
  tenantId: string
  payout: Pick<DisbursementPayout, "id" | "status">
  state: ProviderPayoutState
  reason?: string
  source: "webhook" | "status_query"
  actor: Actor
}): Promise<{ status: PayoutStatus; changed: boolean; conflict?: true; report?: ReportOutcome }> {
  const current = args.payout.status as PayoutStatus
  // Money reported moving on an attempt already over: never applied, never lost.
  if (CONFLICTABLE.includes(current) && args.state !== "FAILED") {
    const report = await recordProviderConflict(db, { tenantId: args.tenantId, payout: args.payout, state: args.state, reason: args.reason, source: args.source, actor: args.actor })
    // A stored (or re-opened) conflict blocks; a stale or dropped report is only audited.
    const stored = report === "recorded" || report === "strengthened" || report === "reopened"
    return { status: current, changed: false, ...(stored ? { conflict: true as const } : {}), report }
  }
  const to = nextFromProvider(current, args.state)
  if (!to) return { status: current, changed: false }
  const changed = await transitionPayout(db, {
    tenantId: args.tenantId, payoutId: args.payout.id, from: current, to,
    data: args.reason ? { failureReason: args.reason.slice(0, 500) } : {},
    actor: args.actor, source: args.source, detail: { reported: args.state, ...(args.reason ? { reason: args.reason } : {}) },
  })
  return { status: changed ? to : current, changed }
}

/** A verified webhook notification, matched to this tenant's payout of that provider. */
export async function ingestNotification(db: PayoutDb, args: {
  tenantId: string
  providerId: string
  notification: PayoutNotification
}): Promise<{ matched: boolean; status?: PayoutStatus; changed?: boolean }> {
  const { notification: n } = args
  if (!n.idempotencyKey && !n.providerReference) return { matched: false }
  const payout = await db.disbursementPayout.findFirst({
    where: {
      tenantId: args.tenantId,
      provider: args.providerId,
      ...(n.idempotencyKey ? { idempotencyKey: n.idempotencyKey } : { providerReference: n.providerReference }),
    },
    select: { id: true, status: true, providerReference: true },
  })
  if (!payout) return { matched: false }
  // Both given: they must name the same payout.
  if (n.idempotencyKey && n.providerReference && payout.providerReference && payout.providerReference !== n.providerReference) {
    return { matched: false }
  }
  const out = await applyProviderState(db, {
    tenantId: args.tenantId, payout, state: n.state, reason: n.reason, source: "webhook",
    actor: { id: null, email: `webhook:${args.providerId}` },
  })
  return { matched: true, ...out }
}

export async function resolvePayout(db: PayoutDb, args: {
  tenantId: string
  payoutId: string
  request: ResolveAction
  actor: Actor & { id: string }
  now?: Date
}): Promise<ResolveResult> {
  const payout = await db.disbursementPayout.findFirst({ where: { id: args.payoutId, tenantId: args.tenantId } })
  if (!payout) return { ok: false, status: 404, error: "Payout not found" }
  const status = payout.status as PayoutStatus
  const now = args.now ?? new Date()
  const req = args.request

  if (req.action === "send") {
    if (status !== "PENDING") return { ok: false, status: 409, error: "Only a payout that was never sent can be sent" }
    const dispatch = await dispatchPayout(db, { tenantId: args.tenantId, payoutId: payout.id, actor: args.actor })
    if (dispatch.kind === "not_sendable") return { ok: false, status: 422, error: dispatch.reason }
    const after = dispatch.kind === "sent" ? dispatch.status : dispatch.status ?? status
    return { ok: true, status: after, changed: dispatch.kind === "sent", dispatch }
  }

  if (req.action === "check") {
    if (status === "SUBMITTING") {
      if (!payout.submittedAt || now.getTime() - payout.submittedAt.getTime() < STALE_SUBMITTING_MS) {
        return { ok: false, status: 409, error: "The payout is being sent; check again in a few minutes" }
      }
      const changed = await transitionPayout(db, {
        tenantId: args.tenantId, payoutId: payout.id, from: "SUBMITTING", to: "NEEDS_REVIEW",
        data: { failureReason: "The send never recorded the provider's answer" }, actor: args.actor, source: "staff_check",
      })
      return { ok: true, status: changed ? "NEEDS_REVIEW" : status, changed }
    }
    if (status !== "SUBMITTED" && status !== "PROCESSING") return { ok: false, status: 409, error: "Nothing to check for this payout" }
    const provider = findPayoutProvider(payout.provider)
    if (!provider?.capabilities.statusQuery || !payout.providerReference) {
      return { ok: false, status: 422, error: "This provider cannot be asked for a payout's status; confirm it from the provider's report" }
    }
    const answer = await provider.getPayoutStatus({ tenantId: args.tenantId, providerReference: payout.providerReference, idempotencyKey: payout.idempotencyKey })
    if (answer.kind !== "state") return { ok: false, status: 502, error: answer.kind === "unknown" ? answer.reason : "Status query not supported" }
    const out = await applyProviderState(db, { tenantId: args.tenantId, payout, state: answer.state, reason: answer.reason, source: "status_query", actor: args.actor })
    return { ok: true, ...out }
  }

  if (req.action === "resolve_conflict") {
    const out = await resolveProviderConflict(db, { tenantId: args.tenantId, payout, outcome: req.outcome, note: req.note, paidAt: req.paidAt ?? null, seen: req.seen, actor: args.actor })
    return out.ok ? { ok: true, status: out.status, changed: true } : out
  }

  if (!CONFIRMABLE.includes(status)) {
    return { ok: false, status: 409, error: "Only a payout under review or awaiting confirmation can be confirmed by staff" }
  }
  // Maker-checker (the database repeats it): the person who disbursed, or who
  // requested this attempt, does not also declare where the money went.
  if (args.actor.id === payout.disbursedById || args.actor.id === payout.createdById || args.actor.id === payout.approvedById) {
    await logAuditStrict({
      tenantId: args.tenantId, userId: args.actor.id, userEmail: args.actor.email,
      action: AuditAction.PAYOUT_ACTION_REFUSED, entity: "DisbursementPayout", entityId: payout.id,
      newValue: { action: req.action, reason: "maker_checker" },
    }, db)
    return { ok: false, status: 403, error: "Another LOAN_ADMIN must confirm this payout: you disbursed the loan, or requested or approved this attempt" }
  }
  const to: PayoutStatus = req.action === "confirm_paid" ? "PAID" : "FAILED"
  const changed = await transitionPayout(db, {
    tenantId: args.tenantId, payoutId: payout.id, from: status, to,
    data: {
      resolvedById: args.actor.id,
      resolutionNote: req.note,
      ...(req.action === "confirm_paid" && req.providerReference ? { providerReference: req.providerReference } : {}),
      // The bank's value date (e.g. from a Netcash report), not the click.
      ...(req.action === "confirm_paid" && req.paidAt ? { paidAt: req.paidAt } : {}),
    },
    actor: args.actor, source: "staff_confirm", detail: { note: req.note },
  })
  if (!changed) return { ok: false, status: 409, error: "The payout changed; refresh and try again" }
  return { ok: true, status: to, changed }
}
