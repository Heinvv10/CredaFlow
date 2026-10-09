// The UI-channel rand formatter — the same one the impact preview renders with,
// so the 409 and the blocker text beside it are not in a second format.
import { formatZAR } from "@/lib/loan-calculator"
import {
  planCommissionBackfill,
  type BackfillCandidate,
  type BackfillSkipReason,
} from "./commission-backfill"

// Retroactive referral commission when a client is re-attributed by hand.
//
// Commission accrues at exactly one moment today — inside the disbursement
// transaction — so attaching an agent to a client whose loan already paid out
// credits them nothing, silently and permanently. Manual attribution is the
// NORMAL path on this system (22 of 23 attributed prod clients on 2026-08-17),
// so the losing path is the normal path.
//
// Pure — no I/O — so the money arithmetic and every exclusion are testable
// without a database. The gates that decide whether an already-disbursed loan
// may accrue live in `planCommissionBackfill` and are DELEGATED to, never
// restated: a second copy of an allow-list drifts, and this is money.

// A commission row's status is a decision about the LOAN, not about who the
// client is attributed to. Re-attribution therefore moves LIVE MONEY and nothing
// else.
//
// Whose row it is never changes what the status means. The outgoing agent's row
// and a third agent's row of the same status get the same disposition — they
// disagreed once, and that disagreement let a LOAN_ADMIN's block be undone
// simply by re-pointing the client.
//
// TWO INDEPENDENT CLASSIFICATIONS read these sets — they are not one partition,
// and they overlap on purpose:
//
//   1. What to REVERSE, from the outgoing agent's rows: `REVERSIBLE` only.
//   2. Why a loan CANNOT ACCRUE, from the rows that survive step 1, tried in
//      order: `ACCRUED` -> ALREADY_ACCRUED, then `WITHHELD` ->
//      WITHHELD_ROW_EXISTS, then anything left -> UNKNOWN_ROW_STATUS.
//
// PAID sits in `ACCRUED` and ALSO raises a blocker when it is the outgoing
// agent's, so it is reachable from both. REVERSED is excluded from the survivor
// set entirely and is judged by the clawback marker instead. Only the second
// classification is exhaustive; the first is an allow-list, which is what makes
// an unrecognised status fail closed rather than being reversed on a guess.

/**
 * Live money: the only rows a re-attribution moves. The outgoing agent's are
 * reversed and the incoming agent accrues in their place.
 *
 * An ALLOW-list. PAID is absent because a payout is not clawed back by an edit
 * form (it raises a blocker instead), REVERSED because it is already spent, and
 * anything unrecognised because nobody knows what it means.
 */
export const REVERSIBLE_COMMISSION_STATUSES = new Set(["PENDING", "PAYABLE"])

/**
 * A recorded LOAN_ADMIN decision to WITHHOLD this loan's commission — fraud, a
 * duplicate, low quality (app/api/agent-hub/referral-events/[id]/route.ts:34-40).
 *
 * It survives a re-attribution untouched. Reversing it would erase the decision;
 * accruing over it would hand the same withheld money to somebody else. The loan
 * is skipped and nobody earns on it until a LOAN_ADMIN decides that row.
 */
export const WITHHELD_COMMISSION_STATUSES = new Set(["BLOCKED", "NOT_ELIGIBLE"])

/**
 * Loan statuses this path must not accrue on even though the shared backfill
 * rule allows them.
 *
 * RESTRUCTURED is eligible under BACKFILL_ELIGIBLE_LOAN_STATUSES, but NO
 * clawback can reach it: app/api/cron/dpd-update/route.ts:88 and
 * lib/collections/escalation.ts:111 both scope to ACTIVE/DEFAULTED. Accruing
 * here would drop a PENDING row into the LOAN_ADMIN payout queue on a loan no
 * reversal path can ever touch — and dpd-update:83-87 records that this exact
 * ledger-policy question was left "deliberately unanswered rather than answered
 * by accident". Answering it in the direction of paying out is not this
 * feature's call.
 *
 * Narrower than the shared constant, and deliberately not applied to it: the
 * operator-run backfill script is human-gated by a dry run in a way this path
 * is not, so changing its behaviour is a separate decision.
 */
export const RETRO_EXCLUDED_LOAN_STATUSES = new Set(["RESTRUCTURED"])

const PAID_COMMISSION_STATUS = "PAID"
const REVERSED_COMMISSION_STATUS = "REVERSED"

/**
 * Money currently owed to somebody for this loan, and the FIRST branch tried
 * when deciding why a loan cannot accrue: a surviving row here makes it
 * ALREADY_ACCRUED. Overlaps `REVERSIBLE` (PENDING, PAYABLE) and contains PAID,
 * which `REVERSIBLE` deliberately does not — see the note at the top.
 *
 * Private: nothing outside this module needs it, and exporting a set that is
 * not part of either public rule would invite a third classification.
 */
const ACCRUED_COMMISSION_STATUSES = new Set(["PENDING", "PAYABLE", PAID_COMMISSION_STATUS])

/**
 * Stamped into a reversed row's metadata by THIS feature, so a later move can
 * tell its own reversal from a collections clawback.
 *
 * Rows already on production carry no marker and are therefore read as
 * clawbacks — the safe default, and the reason the marker is opt-in rather than
 * inferred. `reverseReferralCommissionForLoan` (the default/DPD path) is
 * deliberately left alone and keeps writing unmarked reversals.
 */
export const RE_ATTRIBUTION_REVERSAL = "RE_ATTRIBUTION"

export type RetroSkipReason =
  | BackfillSkipReason
  /** A live CONVERTED row this move does not reverse already credits somebody
   *  for this loan. Idempotent no-op — the second run writes nothing. */
  | "ALREADY_ACCRUED"
  /** A LOAN_ADMIN has withheld this loan's commission (BLOCKED / NOT_ELIGIBLE).
   *  That decision is about the loan and survives the move: the row is neither
   *  reversed nor accrued over, and nobody earns until it is decided. */
  | "WITHHELD_ROW_EXISTS"
  /** A row carries a status this code does not recognise. Not reversed — nobody
   *  knows what it means — and not accrued over. Reported, never silent. */
  | "UNKNOWN_ROW_STATUS"
  /** The loan carries an UNMARKED reversal — the default/collections clawback
   *  path — and a re-attribution must not resurrect commission on a loan that
   *  was clawed back. A reversal this feature wrote is marked and does NOT
   *  count, or pointing a client back at a former agent would pay nobody. */
  | "CLAWED_BACK"
  /** The loan's status is eligible under the shared backfill rule but no
   *  clawback path can reach it — see RETRO_EXCLUDED_LOAN_STATUSES. */
  | "NO_CLAWBACK_PATH"

/** One CONVERTED commission row, as the planner needs to see it. */
export type RetroCommissionEvent = {
  id: string
  loanId: string
  agentId: string | null
  commissionStatus: string
  commissionCents: number | null
  /** The row's raw metadata blob. Read for `reversalReason`, and merged rather
   *  than replaced on reversal — `loanId` lives in here and every idempotency
   *  lookup keys on it. */
  metadata: Record<string, unknown> | null
}

export type RetroReversal = {
  eventId: string
  loanId: string
  loanReference: string
  agentName: string
  /** NULL when the row never recorded one. `commissionCents` is Int?, and
   *  presenting an unrecorded amount as R0.00 states a figure nobody wrote. */
  commissionCents: number | null
  /** Exactly what to write back to the row's metadata column. */
  metadata: Record<string, unknown>
}

/** Was this reversal written by a re-attribution, or by a collections clawback? */
function isReAttributionReversal(event: RetroCommissionEvent): boolean {
  return event.metadata?.reversalReason === RE_ATTRIBUTION_REVERSAL
}

export type RetroBlocker = {
  kind: "PAID_ROW_EXISTS"
  loanReference: string
  agentName: string
}

export type RetroPlan = {
  /** Loans that will accrue for the incoming agent. */
  accrue: (BackfillCandidate & {
    bps: number
    commissionCents: number
    /** A REVERSED prior will still be on this loan when the accrual runs, so the
     *  accrual must be told to look past it. True both for a row THIS move
     *  reverses and for one an earlier move already reversed. */
    supersedesReversedPrior: boolean
  })[]
  /** Live rows belonging to the OUTGOING agent that this move will reverse. */
  reverse: RetroReversal[]
  /** Everything excluded, with the reason, so the UI can show it. */
  skipped: (BackfillCandidate & { reason: RetroSkipReason })[]
  /** Non-empty => the whole operation must be refused. */
  blockers: RetroBlocker[]
  /** Every CONVERTED row that existed for this client's loans when the plan was
   *  built. The write excludes these when verifying, so its verification can
   *  only be satisfied by a row the write itself created. Carried on the plan
   *  rather than threaded through the caller: the caller has no other way to
   *  know them, and a caller that forgot to pass them would silently weaken the
   *  guard back to where it started. */
  knownEventIds: string[]
}

const EMPTY_PLAN: RetroPlan = { accrue: [], reverse: [], skipped: [], blockers: [], knownEventIds: [] }

/**
 * Decide what re-pointing one client's referral attribution should do to the
 * commission ledger.
 *
 * `candidates` must cover the client's WHOLE loan book — the ineligible ones
 * too. The eligibility gates need to report why a loan was left out, and the
 * reversal set is keyed off the same book, so a pre-filtered list would both
 * hide skips from the operator and silently strand the outgoing agent's rows on
 * loans that were filtered away.
 *
 * The agent fields on every candidate describe the INCOMING agent — they are
 * what `planCommissionBackfill` prices and self-referral-checks. The outgoing
 * agent is identified separately because their rows, not their rate, are what
 * this move touches.
 */
export function planRetroAttribution(opts: {
  candidates: BackfillCandidate[]
  tenantCommissionBps: number
  /** Every CONVERTED row for this tenant keyed to one of the client's loans. */
  events: RetroCommissionEvent[]
  incomingAgentId: string | null
  outgoing: { agentId: string; agentName: string } | null
}): RetroPlan {
  const { candidates, tenantCommissionBps, events, incomingAgentId } = opts

  const loanReferenceById = new Map(candidates.map((c) => [c.loanId, c.loanReference]))
  // A row keyed to a loan outside this client's book is somebody else's money.
  const relevant = events.filter((e) => loanReferenceById.has(e.loanId))

  // Two codes can belong to one agent. Reversing and re-accruing that agent's
  // own rows would churn the ledger without changing who gets paid, so treat it
  // as no move at all; the existing rows then read as ALREADY_ACCRUED.
  const outgoing = opts.outgoing && opts.outgoing.agentId !== incomingAgentId ? opts.outgoing : null
  const outgoingRows = outgoing ? relevant.filter((e) => e.agentId === outgoing.agentId) : []

  // Nothing writes PAID today (the payout module is unbuilt), but the guard has
  // to exist BEFORE it ships, not after. A reversal of money already paid out
  // is a recovery, not an edit, so refuse the whole operation rather than
  // applying half of it.
  //
  // Derived from the UNFILTERED rows, deliberately. Reading the reversal-set
  // rows instead made this refusal conditional on a filter added for an
  // unrelated reason: a PAID row on a RESTRUCTURED loan stopped raising a
  // blocker and the move went ahead. A refusal must never be narrowed as a side
  // effect of something else.
  const blockers: RetroBlocker[] = outgoingRows
    .filter((e) => e.commissionStatus === PAID_COMMISSION_STATUS)
    .map((e) => ({
      kind: "PAID_ROW_EXISTS" as const,
      loanReference: loanReferenceById.get(e.loanId)!,
      agentName: outgoing!.agentName,
    }))
  const knownEventIds = relevant.map((e) => e.id)
  if (blockers.length > 0) return { ...EMPTY_PLAN, blockers, knownEventIds }

  // A re-point is a CORRECTION: the outgoing agent's claim on this client ends
  // when the attribution moves, so their live money is reversed whether or not
  // anyone accrues in its place. That is deliberate and is why clearing the
  // agent entirely also reverses with no successor.
  //
  // RETRO_EXCLUDED_LOAN_STATUSES is the one exception, and it is a different
  // objection: there the problem is touching that LOAN at all, not whether that
  // AGENT has earned. So an untouchable loan is left wholly alone — neither
  // credited nor debited — while SELF_REFERRAL, ZERO_RATE and an ineligible
  // loan status still reverse the outgoing agent with no successor, correctly.
  const untouchableLoanIds = new Set(
    candidates.filter((c) => RETRO_EXCLUDED_LOAN_STATUSES.has(c.loanStatus)).map((c) => c.loanId),
  )
  // LIVE MONEY only. A withheld row is a decision about the loan and survives;
  // an unrecognised status is not reversed because nobody knows what it means.
  // Both are reported through `skipped` rather than silently left behind.
  const reverse: RetroReversal[] = outgoingRows
    .filter((e) => !untouchableLoanIds.has(e.loanId))
    .filter((e) => REVERSIBLE_COMMISSION_STATUSES.has(e.commissionStatus))
    .map((e) => ({
      eventId: e.id,
      loanId: e.loanId,
      loanReference: loanReferenceById.get(e.loanId)!,
      agentName: outgoing!.agentName,
      commissionCents: e.commissionCents,
      // MERGED, never replaced: loanId lives in this blob and every idempotency
      // lookup keys on it. A `loanId` fallback is spelled out because a row whose
      // metadata was somehow lost must not be orphaned from its loan by the very
      // write that marks it.
      metadata: { loanId: e.loanId, ...(e.metadata ?? {}), reversalReason: RE_ATTRIBUTION_REVERSAL },
    }))

  // Clearing the attribution. The outgoing agent stops earning; nobody accrues,
  // and there is no incoming agent to price the book against — reporting every
  // loan as CODE_NOT_ACTIVE would be noise, not information.
  if (!incomingAgentId) return { ...EMPTY_PLAN, reverse, knownEventIds }

  const rowsByLoan = new Map<string, RetroCommissionEvent[]>()
  for (const e of relevant) {
    rowsByLoan.set(e.loanId, [...(rowsByLoan.get(e.loanId) ?? []), e])
  }
  const reversedHere = new Set(reverse.map((r) => r.eventId))

  const base = planCommissionBackfill(candidates, tenantCommissionBps)
  const plan: RetroPlan = {
    accrue: [], reverse, skipped: [...base.skipped], blockers: [], knownEventIds,
  }

  for (const c of base.accrue) {
    // Checked first: it is the most DURABLE exclusion. No decision on the
    // commission rows, and no later re-attribution, will ever make a loan no
    // clawback can reach safe to accrue on, so leading with any other reason
    // sends the operator down a road that does not end in payment.
    if (RETRO_EXCLUDED_LOAN_STATUSES.has(c.loanStatus)) {
      plan.skipped.push({ ...c, reason: "NO_CLAWBACK_PATH" })
      continue
    }
    const rows = rowsByLoan.get(c.loanId) ?? []
    // Exactly the rows `recordDisbursementCommission` will still see once this
    // move's reversals have landed. If any survives, the accrual would be
    // declined by its idempotency check anyway — including a live row belonging
    // to some third agent, which this move has no mandate to move.
    const surviving = rows.filter(
      (r) => r.commissionStatus !== REVERSED_COMMISSION_STATUS && !reversedHere.has(r.id),
    )
    if (surviving.some((r) => ACCRUED_COMMISSION_STATUSES.has(r.commissionStatus))) {
      plan.skipped.push({ ...c, reason: "ALREADY_ACCRUED" })
      continue
    }
    // A withheld decision stands. Reached for the outgoing agent's row as well
    // as anyone else's — the reversal set above no longer takes it, so it is
    // still here — which is exactly the agreement the two branches used to lack.
    if (surviving.some((r) => WITHHELD_COMMISSION_STATUSES.has(r.commissionStatus))) {
      plan.skipped.push({ ...c, reason: "WITHHELD_ROW_EXISTS" })
      continue
    }
    // Anything left is a status this code does not know. Fail closed and say so.
    if (surviving.length > 0) {
      plan.skipped.push({ ...c, reason: "UNKNOWN_ROW_STATUS" })
      continue
    }
    // Checked AFTER the lines above so the second run of the same move is a
    // no-op. Only an UNMARKED reversal is a clawback: a reversal this feature
    // wrote is a re-attribution, and reading it as a clawback destroyed both
    // accruals when a client was pointed back at a former agent.
    const priorReversals = rows.filter((r) => r.commissionStatus === REVERSED_COMMISSION_STATUS)
    if (priorReversals.some((r) => !isReAttributionReversal(r))) {
      plan.skipped.push({ ...c, reason: "CLAWED_BACK" })
      continue
    }
    // Any reversed row still on the loan — reversed here or on an earlier move —
    // has to be superseded, or the accrual's own idempotency check declines it.
    plan.accrue.push({
      ...c,
      supersedesReversedPrior: priorReversals.length > 0 || rows.some((r) => reversedHere.has(r.id)),
    })
  }

  return plan
}


/** Sums only the amounts that were actually recorded. Rows with no amount are
 *  counted separately (`reverseUnknownCount`) rather than added in as zero. */
function totalKnownReverseCents(plan: RetroPlan): number {
  return plan.reverse.reduce((sum, r) => sum + (r.commissionCents ?? 0), 0)
}

export type RetroPreviewTotals = { totalAccrueCents: number; totalReverseCents: number }

/**
 * Refuse to write figures other than the ones the operator approved.
 *
 * The preview and the write each build their own plan, so a rate change (or a
 * loan disbursing, or a clawback landing) between the two silently swaps what
 * gets written for something nobody signed off on. Mirrors the refusal
 * `applyBackfillAccrual` already performs on a plan/write disagreement: a
 * rollback is safe because the move is idempotent, so a corrected re-run picks
 * the client up again.
 *
 * Returns null when they agree, or operator-facing text naming both figures.
 */
export function describeRetroPreviewMismatch(
  plan: RetroPlan,
  approved: RetroPreviewTotals,
): string | null {
  const actual = {
    totalAccrueCents: plan.accrue.reduce((sum, a) => sum + a.commissionCents, 0),
    totalReverseCents: totalKnownReverseCents(plan),
  }
  if (
    actual.totalAccrueCents === approved.totalAccrueCents &&
    actual.totalReverseCents === approved.totalReverseCents
  ) return null

  return (
    "The commission impact changed while this form was open: you approved " +
    `${formatZAR(approved.totalAccrueCents)} credited and ${formatZAR(approved.totalReverseCents)} reversed, ` +
    `but saving now would credit ${formatZAR(actual.totalAccrueCents)} and reverse ` +
    `${formatZAR(actual.totalReverseCents)}. Nothing was written — reopen the client and check the new figures.`
  )
}

/** Operator-facing refusal text. Names the loan and who was already paid on it. */
export function describeRetroBlockers(blockers: RetroBlocker[]): string {
  const detail = blockers
    .map((b) => `${b.loanReference} (paid to ${b.agentName})`)
    .join(", ")
  return (
    "Cannot move this client's referral agent: commission has already been PAID on " +
    `${detail}. Reverse the payout first — an edit form must not claw back money that has left the business.`
  )
}

/**
 * The wire shape shared by the confirmation preview and the write. Both derive
 * it from the same plan, so the rand figure an operator signs off on is the one
 * that gets written.
 */
export function serialiseRetroPlan(plan: RetroPlan) {
  return {
    accrue: plan.accrue.map((a) => ({
      loanReference: a.loanReference,
      principalCents: a.principalCents,
      commissionCents: a.commissionCents,
    })),
    reverse: plan.reverse.map((r) => ({
      loanReference: r.loanReference,
      agentName: r.agentName,
      commissionCents: r.commissionCents,
    })),
    skipped: plan.skipped.map((s) => ({ loanReference: s.loanReference, reason: s.reason })),
    blockers: plan.blockers,
    totalAccrueCents: plan.accrue.reduce((sum, a) => sum + a.commissionCents, 0),
    /** KNOWN amounts only. */
    totalReverseCents: totalKnownReverseCents(plan),
    /** How many reversals the total above cannot account for, so the preview can
     *  say so instead of letting the figure read as complete. */
    reverseUnknownCount: plan.reverse.filter((r) => r.commissionCents === null).length,
  }
}

export type SerialisedRetroPlan = ReturnType<typeof serialiseRetroPlan>
