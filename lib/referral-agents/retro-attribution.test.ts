import { describe, it, expect } from "vitest"
import {
  planRetroAttribution,
  describeRetroBlockers,
  serialiseRetroPlan,
  RE_ATTRIBUTION_REVERSAL,
  describeRetroPreviewMismatch,
  type RetroCommissionEvent,
} from "./retro-attribution"
import {
  planCommissionBackfill,
  BACKFILL_ELIGIBLE_LOAN_STATUSES,
  type BackfillCandidate,
} from "./commission-backfill"

function candidate(over: Partial<BackfillCandidate> = {}): BackfillCandidate {
  return {
    loanId: "L1",
    loanReference: "LN-0001",
    loanStatus: "ACTIVE",
    loanCreatedAt: "2026-07-01",
    principalCents: 100_000,
    clientId: "client-1",
    clientName: "Test Client",
    clientPhone: null,
    clientEmail: null,
    agentId: "agent-1",
    agentName: "Incoming Agent",
    agentPhone: null,
    agentEmail: null,
    agentStatus: "ACTIVE",
    agentCommissionBps: null,
    codeValue: "CODE-B",
    codeStatus: "ACTIVE",
    ...over,
  }
}

function event(over: Partial<RetroCommissionEvent> = {}): RetroCommissionEvent {
  return {
    id: "evt-1",
    loanId: "L1",
    agentId: "agent-a",
    commissionStatus: "PENDING",
    commissionCents: 1_000,
    metadata: { loanId: "L1", principalCents: 100_000, bps: 100 },
    ...over,
  }
}

/** A row this feature reversed on an earlier move — marked, so not a clawback. */
function reAttributionReversal(over: Partial<RetroCommissionEvent> = {}): RetroCommissionEvent {
  const base = event({ commissionStatus: "REVERSED", ...over })
  return { ...base, metadata: { ...base.metadata, reversalReason: RE_ATTRIBUTION_REVERSAL } }
}

// The UI-channel formatter (non-breaking space + thousands separator), spelled
// as an escape so a plain space cannot creep in and pass against the wrong one.
const zar = (cents: number) => `R\u00A0${(cents / 100).toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`

const OUTGOING = { agentId: "agent-a", agentName: "Outgoing Agent" }

describe("planRetroAttribution", () => {
  it("accrues every eligible past loan, a COMPLETED one included", () => {
    const plan = planRetroAttribution({
      candidates: [
        candidate({ loanId: "L1", loanReference: "LN-0001", loanStatus: "ACTIVE" }),
        candidate({ loanId: "L2", loanReference: "LN-0002", loanStatus: "COMPLETED", principalCents: 200_000 }),
      ],
      tenantCommissionBps: 100,
      events: [],
      incomingAgentId: "agent-b",
      outgoing: null,
    })

    expect(plan.blockers).toEqual([])
    expect(plan.accrue.map((a) => a.loanId)).toEqual(["L1", "L2"])
    expect(plan.accrue.map((a) => a.commissionCents)).toEqual([1_000, 2_000])
    expect(plan.skipped).toEqual([])
  })

  // Delegated to BACKFILL_ELIGIBLE_LOAN_STATUSES rather than restated here; a
  // second copy of the allow-list is how the two paths drift apart.
  it.each(["DEFAULTED", "WRITTEN_OFF"])("skips a %s loan via the existing allow-list", (loanStatus) => {
    const plan = planRetroAttribution({
      candidates: [candidate({ loanStatus })],
      tenantCommissionBps: 100,
      events: [],
      incomingAgentId: "agent-b",
      outgoing: null,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ reason: "INELIGIBLE_LOAN_STATUS" })
  })

  it("skips a loan the incoming agent has already accrued, so a repeated move writes once", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-b", agentId: "agent-b", commissionStatus: "PENDING" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ loanId: "L1", reason: "ALREADY_ACCRUED" })
  })

  // The second run of the SAME move: A's row is now REVERSED and B's is live.
  // ALREADY_ACCRUED must win over CLAWED_BACK or the move stops being idempotent.
  it("stays a no-op on the second run of the same re-attribution", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [
        reAttributionReversal({ id: "evt-a", agentId: "agent-a" }),
        event({ id: "evt-b", agentId: "agent-b", commissionStatus: "PENDING" }),
      ],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.reverse).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ reason: "ALREADY_ACCRUED" })
  })

  // An UNMARKED reversal is a collections clawback
  // (reverseReferralCommissionForLoan, via app/api/cron/dpd-update). Every row
  // that predates the marker is unmarked, so this is also the migration-safe default.
  it("refuses to resurrect commission on a loan that was clawed back", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-clawback", agentId: "agent-a", commissionStatus: "REVERSED" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.reverse).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ reason: "CLAWED_BACK" })
  })

  it("treats a reversal carrying no metadata at all as a clawback", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-old", agentId: "agent-a", commissionStatus: "REVERSED", metadata: null })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.skipped[0]).toMatchObject({ reason: "CLAWED_BACK" })
  })

  // MED-1. A -> B, then B -> A. A's own row is still REVERSED from the first
  // move; reading that as a clawback destroyed both accruals permanently and
  // reported a reason that was simply untrue — nothing was ever clawed back.
  it("re-credits a former agent when the client is pointed back at them", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [
        reAttributionReversal({ id: "evt-a", agentId: "agent-a" }),
        event({ id: "evt-b", agentId: "agent-b", commissionStatus: "PENDING", commissionCents: 1_000 }),
      ],
      incomingAgentId: "agent-a",
      outgoing: { agentId: "agent-b", agentName: "Agent B" },
    })

    expect(plan.reverse).toMatchObject([{ eventId: "evt-b", agentName: "Agent B" }])
    expect(plan.accrue).toHaveLength(1)
    expect(plan.accrue[0]).toMatchObject({ loanId: "L1", commissionCents: 1_000 })
  })

  // The same defect one step along: A -> B -> C paid C nothing.
  it("credits a third agent after two prior moves", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [
        reAttributionReversal({ id: "evt-a", agentId: "agent-a" }),
        event({ id: "evt-b", agentId: "agent-b", commissionStatus: "PENDING" }),
      ],
      incomingAgentId: "agent-c",
      outgoing: { agentId: "agent-b", agentName: "Agent B" },
    })

    expect(plan.accrue).toHaveLength(1)
    expect(plan.skipped).toEqual([])
  })

  // One unmarked reversal is enough: a loan that was genuinely clawed back must
  // stay off limits however many re-attributions have since touched it.
  it("still refuses when a clawback sits alongside a re-attribution reversal", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [
        reAttributionReversal({ id: "evt-a", agentId: "agent-a" }),
        event({ id: "evt-clawback", agentId: "agent-b", commissionStatus: "REVERSED" }),
      ],
      incomingAgentId: "agent-c",
      outgoing: null,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ reason: "CLAWED_BACK" })
  })

  // The accrual must look past a REVERSED prior it is entitled to supersede —
  // including one reversed on an EARLIER move, where this transaction reverses
  // nothing for the loan itself.
  it("marks an accrual as superseding whenever a reversed prior remains", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [reAttributionReversal({ id: "evt-a", agentId: "agent-a" })],
      incomingAgentId: "agent-c",
      outgoing: null,
    })

    expect(plan.reverse).toEqual([])
    expect(plan.accrue[0].supersedesReversedPrior).toBe(true)
  })

  it("marks a loan with no prior rows as not superseding anything", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [],
      incomingAgentId: "agent-b",
      outgoing: null,
    })

    expect(plan.accrue[0].supersedesReversedPrior).toBe(false)
  })

  // MED-2. commissionStatus is a free String and
  // app/api/agent-hub/referral-events/[id]/route.ts:134 refuses only REVERSED,
  // so a LOAN_ADMIN can decide a BLOCKED row back to PAYABLE. It therefore still
  // has to block — but calling it ALREADY_ACCRUED told the operator money had
  // been credited when none had.
  it.each(["BLOCKED", "NOT_ELIGIBLE"])(
    "blocks on a revivable %s row, and says so accurately",
    (commissionStatus) => {
      const plan = planRetroAttribution({
        candidates: [candidate()],
        tenantCommissionBps: 100,
        events: [event({ id: "evt-x", agentId: "agent-x", commissionStatus })],
        incomingAgentId: "agent-b",
        outgoing: OUTGOING,
      })

      expect(plan.accrue).toEqual([])
      expect(plan.skipped[0]).toMatchObject({ reason: "WITHHELD_ROW_EXISTS" })
    },
  )

  // A commission row's status is a decision about the
  // LOAN, not about the attribution, so a re-attribution moves only LIVE MONEY.
  //
  // BLOCKED / NOT_ELIGIBLE / unknown rows must NOT be reversed, and the
  // incoming agent must not accrue on them. Reversing them would let a LOAN_ADMIN's block for fraud,
  // duplicate or low quality be undone by re-pointing the client, with the money
  // reappearing payable to someone else — no second actor needed.
  it.each(["PENDING", "PAYABLE"])(
    "moves the outgoing agent's live %s row to the incoming agent",
    (commissionStatus) => {
      const plan = planRetroAttribution({
        candidates: [candidate()],
        tenantCommissionBps: 100,
        events: [event({ id: "evt-a", agentId: "agent-a", commissionStatus })],
        incomingAgentId: "agent-b",
        outgoing: OUTGOING,
      })

      expect(plan.reverse.map((r) => r.eventId)).toEqual(["evt-a"])
      expect(plan.accrue).toHaveLength(1)
      expect(plan.accrue[0].supersedesReversedPrior).toBe(true)
    },
  )

  // A block STICKS. Not reversed, not accrued over — the loan is skipped and
  // nobody earns on it until a LOAN_ADMIN explicitly decides that row.
  it.each(["BLOCKED", "NOT_ELIGIBLE"])(
    "leaves the outgoing agent's withheld %s row standing, and credits nobody",
    (commissionStatus) => {
      const plan = planRetroAttribution({
        candidates: [candidate()],
        tenantCommissionBps: 100,
        events: [event({ id: "evt-a", agentId: "agent-a", commissionStatus })],
        incomingAgentId: "agent-b",
        outgoing: OUTGOING,
      })

      expect(plan.reverse).toEqual([])
      expect(plan.accrue).toEqual([])
      expect(plan.skipped[0]).toMatchObject({ reason: "WITHHELD_ROW_EXISTS" })
    },
  )

  // What the previous round's inversion got RIGHT and this must keep: an
  // unrecognised status is never silently left behind. It is not reversed
  // (nobody knows what it means) and it is not accrued over — it is REPORTED.
  it("fails closed on an unrecognised status rather than guessing", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-a", agentId: "agent-a", commissionStatus: "SOME_FUTURE_STATUS" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.reverse).toEqual([])
    expect(plan.accrue).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ reason: "UNKNOWN_ROW_STATUS" })
  })

  // The finding was that the two branches DISAGREED: the same BLOCKED row was
  // reversed if it belonged to the outgoing agent and honoured if it belonged to
  // anyone else. Whose row it is cannot change what the status means.
  it.each([
    ["BLOCKED", "WITHHELD_ROW_EXISTS"],
    ["NOT_ELIGIBLE", "WITHHELD_ROW_EXISTS"],
    ["SOME_FUTURE_STATUS", "UNKNOWN_ROW_STATUS"],
  ])("disposes of a %s row identically whoever owns it", (commissionStatus, reason) => {
    const forAgent = (agentId: string) => planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-x", agentId, commissionStatus })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    for (const owner of ["agent-a", "agent-c"]) {
      const plan = forAgent(owner)
      expect(plan.reverse).toEqual([])
      expect(plan.accrue).toEqual([])
      expect(plan.skipped[0]).toMatchObject({ reason })
    }
  })

  it("leaves an already-REVERSED outgoing row alone — there is nothing to terminate", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [reAttributionReversal({ id: "evt-a", agentId: "agent-a" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.reverse).toEqual([])
  })

  // A withheld row belonging to a THIRD agent is not this move's to terminate,
  // so it still blocks — and the reason still has to be true.
  it("still reports a third agent's withheld row rather than accruing over it", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-c", agentId: "agent-c", commissionStatus: "BLOCKED" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.reverse).toEqual([])
    expect(plan.accrue).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ reason: "WITHHELD_ROW_EXISTS" })
  })

  it.each(["PENDING", "PAYABLE", "PAID"])(
    "reports a live %s row as ALREADY_ACCRUED",
    (commissionStatus) => {
      const plan = planRetroAttribution({
        candidates: [candidate()],
        tenantCommissionBps: 100,
        events: [event({ id: "evt-x", agentId: "agent-x", commissionStatus })],
        incomingAgentId: "agent-b",
        outgoing: OUTGOING,
      })

      expect(plan.skipped[0]).toMatchObject({ reason: "ALREADY_ACCRUED" })
    },
  )

  // NEW-4. RESTRUCTURED is eligible under the SHARED backfill rule, but no
  // clawback path can reach it: lib/loan/dpd-update.ts (the 90-DPD clawback) and
  // lib/collections/escalation.ts:111 both scope to ACTIVE/DEFAULTED. Accruing
  // here would put a PENDING row in the payout queue on a loan structurally
  // unreachable by every reversal — answering a ledger-policy question that
  // dpd-update:83-87 says was deliberately left open, in the direction of paying.
  it("refuses to accrue on a RESTRUCTURED loan no clawback can reach", () => {
    const plan = planRetroAttribution({
      candidates: [candidate({ loanStatus: "RESTRUCTURED" })],
      tenantCommissionBps: 100,
      events: [],
      incomingAgentId: "agent-b",
      outgoing: null,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ loanId: "L1", reason: "NO_CLAWBACK_PATH" })
  })

  // `blockers` must not read the same untouchable-filtered rows the reversal
  // set does: otherwise a PAID row on a
  // RESTRUCTURED loan would stop raising PAID_ROW_EXISTS and the operation
  // would proceed. A refusal must never be narrowed as a side effect of a filter
  // added for an unrelated reason.
  it("still refuses when the outgoing agent was PAID on an untouchable loan", () => {
    const plan = planRetroAttribution({
      candidates: [candidate({ loanStatus: "RESTRUCTURED" })],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-paid", agentId: "agent-a", commissionStatus: "PAID" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.blockers).toEqual([
      { kind: "PAID_ROW_EXISTS", loanReference: "LN-0001", agentName: "Outgoing Agent" },
    ])
    expect(plan.accrue).toEqual([])
    expect(plan.reverse).toEqual([])
  })

  // The blocker refuses the WHOLE operation, so an untouchable loan carrying a
  // PAID row must stop the client's other loans moving too.
  it("refuses the whole move, not just the untouchable loan", () => {
    const plan = planRetroAttribution({
      candidates: [
        candidate({ loanId: "L1", loanReference: "LN-0001", loanStatus: "RESTRUCTURED" }),
        candidate({ loanId: "L2", loanReference: "LN-0002", loanStatus: "ACTIVE" }),
      ],
      tenantCommissionBps: 100,
      events: [
        event({ id: "evt-paid", loanId: "L1", agentId: "agent-a", commissionStatus: "PAID" }),
        event({ id: "evt-live", loanId: "L2", agentId: "agent-a", commissionStatus: "PENDING" }),
      ],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.blockers).toHaveLength(1)
    expect(plan.reverse).toEqual([])
    expect(plan.accrue).toEqual([])
  })

  // The reversal set needs a loan-status filter: without one the outgoing agent's
  // row on a RESTRUCTURED loan is reversed while NO_CLAWBACK_PATH forbids
  // crediting anyone. Net effect: the payable was destroyed and nobody could
  // ever receive it. A loan this move cannot credit must not be debited either.
  it("leaves a RESTRUCTURED loan wholly untouched rather than debiting it to nobody", () => {
    const plan = planRetroAttribution({
      candidates: [candidate({ loanStatus: "RESTRUCTURED" })],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-a", agentId: "agent-a", commissionStatus: "PENDING" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.reverse).toEqual([])
    expect(plan.accrue).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ reason: "NO_CLAWBACK_PATH" })
  })

  // The exclusion is per LOAN, not per client: an untouchable loan must not
  // stop the client's other loans from moving.
  it("still moves the client's other loans alongside an excluded one", () => {
    const plan = planRetroAttribution({
      candidates: [
        candidate({ loanId: "L1", loanReference: "LN-0001", loanStatus: "RESTRUCTURED" }),
        candidate({ loanId: "L2", loanReference: "LN-0002", loanStatus: "ACTIVE" }),
      ],
      tenantCommissionBps: 100,
      events: [
        event({ id: "evt-a1", loanId: "L1", agentId: "agent-a", commissionStatus: "PENDING" }),
        event({ id: "evt-a2", loanId: "L2", agentId: "agent-a", commissionStatus: "PENDING" }),
      ],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.reverse.map((r) => r.eventId)).toEqual(["evt-a2"])
    expect(plan.accrue.map((a) => a.loanId)).toEqual(["L2"])
    expect(plan.skipped[0]).toMatchObject({ loanId: "L1", reason: "NO_CLAWBACK_PATH" })
  })

  // Clearing the agent is still a re-attribution: the same loan must not be
  // debited to nobody on that path either.
  it("leaves an excluded loan untouched when the agent is cleared", () => {
    const plan = planRetroAttribution({
      candidates: [candidate({ loanStatus: "RESTRUCTURED" })],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-a", agentId: "agent-a", commissionStatus: "PENDING" })],
      incomingAgentId: null,
      outgoing: OUTGOING,
    })

    expect(plan.reverse).toEqual([])
  })

  it("still accrues the statuses a clawback CAN reach", () => {
    const plan = planRetroAttribution({
      candidates: [
        candidate({ loanId: "L1", loanStatus: "ACTIVE" }),
        candidate({ loanId: "L2", loanStatus: "COMPLETED" }),
      ],
      tenantCommissionBps: 100,
      events: [],
      incomingAgentId: "agent-b",
      outgoing: null,
    })

    expect(plan.accrue.map((a) => a.loanId)).toEqual(["L1", "L2"])
  })

  // The exclusion is the RETRO path's alone. The operator-run backfill script is
  // human-gated by a dry run in a way this path is not, so narrowing the shared
  // constant would silently change a separate, already-signed-off decision.
  it("leaves the shared backfill rule alone", () => {
    expect(BACKFILL_ELIGIBLE_LOAN_STATUSES.has("RESTRUCTURED")).toBe(true)
    expect(planCommissionBackfill([candidate({ loanStatus: "RESTRUCTURED" })], 100).accrue)
      .toHaveLength(1)
  })

  it("reverses exactly the outgoing agent's live rows and nobody else's", () => {
    const plan = planRetroAttribution({
      candidates: [
        candidate({ loanId: "L1", loanReference: "LN-0001" }),
        candidate({ loanId: "L2", loanReference: "LN-0002" }),
        candidate({ loanId: "L3", loanReference: "LN-0003" }),
      ],
      tenantCommissionBps: 100,
      events: [
        event({ id: "evt-a1", loanId: "L1", agentId: "agent-a", commissionStatus: "PENDING", commissionCents: 1_000 }),
        event({ id: "evt-a2", loanId: "L2", agentId: "agent-a", commissionStatus: "PAYABLE", commissionCents: 1_500 }),
        // Another agent's live row: not ours to move.
        event({ id: "evt-c", loanId: "L3", agentId: "agent-c", commissionStatus: "PENDING" }),
      ],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    // toMatchObject on an array still asserts the LENGTH, so a third agent's row
    // creeping into the set fails here.
    expect(plan.reverse).toMatchObject([
      { eventId: "evt-a1", loanId: "L1", loanReference: "LN-0001", agentName: "Outgoing Agent", commissionCents: 1_000 },
      { eventId: "evt-a2", loanId: "L2", loanReference: "LN-0002", agentName: "Outgoing Agent", commissionCents: 1_500 },
    ])
    expect(plan.accrue.map((a) => a.loanId)).toEqual(["L1", "L2"])
    // L3 still carries a live row this move does not reverse, so nothing may be
    // written on top of it.
    expect(plan.skipped).toEqual([expect.objectContaining({ loanId: "L3", reason: "ALREADY_ACCRUED" })])
  })

  it("ignores events belonging to loans outside this client's book", () => {
    const plan = planRetroAttribution({
      candidates: [candidate({ loanId: "L1" })],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-other", loanId: "SOMEONE-ELSE", agentId: "agent-a" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.reverse).toEqual([])
    expect(plan.accrue).toHaveLength(1)
  })

  it("blocks the whole operation when the outgoing agent has been PAID, planning nothing", () => {
    const plan = planRetroAttribution({
      candidates: [
        candidate({ loanId: "L1", loanReference: "LN-0001" }),
        candidate({ loanId: "L2", loanReference: "LN-0002" }),
      ],
      tenantCommissionBps: 100,
      events: [
        event({ id: "evt-paid", loanId: "L1", agentId: "agent-a", commissionStatus: "PAID" }),
        event({ id: "evt-live", loanId: "L2", agentId: "agent-a", commissionStatus: "PENDING" }),
      ],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.blockers).toEqual([
      { kind: "PAID_ROW_EXISTS", loanReference: "LN-0001", agentName: "Outgoing Agent" },
    ])
    expect(plan.accrue).toEqual([])
    expect(plan.reverse).toEqual([])
    expect(plan.skipped).toEqual([])
  })

  // Delegated to isSelfReferral. Asserted here so a future refactor that drops
  // the delegation fails a test rather than paying an agent on their own loan.
  it("excludes a self-referral", () => {
    const plan = planRetroAttribution({
      candidates: [candidate({ clientName: "Agent Two", agentName: "agent  two" })],
      tenantCommissionBps: 100,
      events: [],
      incomingAgentId: "agent-b",
      outgoing: null,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ reason: "SELF_REFERRAL" })
  })

  it("reports a zero rate as ZERO_RATE rather than a silent nothing", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 0,
      events: [],
      incomingAgentId: "agent-b",
      outgoing: null,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ reason: "ZERO_RATE" })
  })

  it("reverses and accrues nothing when the agent is cleared", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-a", agentId: "agent-a", commissionStatus: "PENDING" })],
      incomingAgentId: null,
      outgoing: OUTGOING,
    })

    expect(plan.reverse).toHaveLength(1)
    expect(plan.accrue).toEqual([])
    expect(plan.skipped).toEqual([])
  })

  // Two codes, one agent. Reversing and re-accruing the same agent's own rows
  // would churn the ledger for no change of payee.
  it("moves no money when both codes belong to the same agent", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-a", agentId: "agent-a", commissionStatus: "PENDING" })],
      incomingAgentId: "agent-a",
      outgoing: OUTGOING,
    })

    expect(plan.reverse).toEqual([])
    expect(plan.accrue).toEqual([])
    expect(plan.skipped[0]).toMatchObject({ reason: "ALREADY_ACCRUED" })
  })
})

// NEW-1. The write proves the row it verifies is one IT created by excluding
// every row the plan already saw. The plan is the only thing that knows them.
describe("knownEventIds", () => {
  it("records every commission row the plan was computed from", () => {
    const plan = planRetroAttribution({
      candidates: [
        candidate({ loanId: "L1", loanReference: "LN-0001" }),
        candidate({ loanId: "L2", loanReference: "LN-0002" }),
      ],
      tenantCommissionBps: 100,
      events: [
        event({ id: "evt-a1", loanId: "L1", agentId: "agent-a" }),
        event({ id: "evt-a2", loanId: "L2", agentId: "agent-a", commissionStatus: "BLOCKED" }),
      ],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.knownEventIds.sort()).toEqual(["evt-a1", "evt-a2"])
  })

  it("records them even when the plan is refused outright", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-paid", agentId: "agent-a", commissionStatus: "PAID" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.blockers).toHaveLength(1)
    expect(plan.knownEventIds).toEqual(["evt-paid"])
  })

  it("excludes rows keyed to loans outside this client's book", () => {
    const plan = planRetroAttribution({
      candidates: [candidate({ loanId: "L1" })],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-elsewhere", loanId: "SOMEONE-ELSE", agentId: "agent-a" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.knownEventIds).toEqual([])
  })
})

describe("reversal metadata", () => {
  // The marker is what a LATER move reads to tell a re-attribution reversal from
  // a collections clawback, so it has to survive onto the row.
  it("carries the existing metadata plus the re-attribution marker", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-a", agentId: "agent-a", commissionStatus: "PENDING" })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.reverse[0].metadata).toEqual({
      loanId: "L1",
      principalCents: 100_000,
      bps: 100,
      reversalReason: RE_ATTRIBUTION_REVERSAL,
    })
  })

  // loanId is the key every idempotency lookup joins on. Replacing the blob
  // instead of merging it would orphan the row from its loan.
  it("never drops the loanId the idempotency lookup keys on", () => {
    const plan = planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-a", agentId: "agent-a", metadata: null })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(plan.reverse[0].metadata).toMatchObject({ loanId: "L1" })
  })
})

// NEW-3. commissionCents is Int?. Reporting an unrecorded amount as "R0.00" on
// a money surface states a figure nobody wrote — the same class of claim the
// field's own comments already refuse to make about the agent name.
describe("a reversal whose amount was never recorded", () => {
  const planWithNullCents = () => planRetroAttribution({
    candidates: [
      candidate({ loanId: "L1", loanReference: "LN-0001" }),
      candidate({ loanId: "L2", loanReference: "LN-0002" }),
    ],
    tenantCommissionBps: 100,
    events: [
      event({ id: "evt-known", loanId: "L1", agentId: "agent-a", commissionCents: 900 }),
      event({ id: "evt-null", loanId: "L2", agentId: "agent-a", commissionCents: null }),
    ],
    incomingAgentId: "agent-b",
    outgoing: OUTGOING,
  })

  it("carries the unknown through as null rather than inventing a zero", () => {
    const reverse = planWithNullCents().reverse
    expect(reverse.find((r) => r.eventId === "evt-null")!.commissionCents).toBeNull()
    expect(reverse.find((r) => r.eventId === "evt-known")!.commissionCents).toBe(900)
  })

  it("totals only what is actually known, and says how much is not", () => {
    const serialised = serialiseRetroPlan(planWithNullCents())
    expect(serialised.totalReverseCents).toBe(900)
    expect(serialised.reverseUnknownCount).toBe(1)
  })

  it("reports nothing unknown when every amount is recorded", () => {
    const serialised = serialiseRetroPlan(planRetroAttribution({
      candidates: [candidate()],
      tenantCommissionBps: 100,
      events: [event({ id: "evt-a", agentId: "agent-a", commissionCents: 900 })],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    }))
    expect(serialised.reverseUnknownCount).toBe(0)
  })

  it("still reverses the row — an unrecorded amount is not a reason to leave it", () => {
    expect(planWithNullCents().reverse.map((r) => r.eventId)).toEqual(["evt-known", "evt-null"])
  })
})

describe("describeRetroPreviewMismatch", () => {
  const plan = () => planRetroAttribution({
    candidates: [candidate()],
    tenantCommissionBps: 100,
    events: [event({ id: "evt-a", agentId: "agent-a", commissionCents: 900 })],
    incomingAgentId: "agent-b",
    outgoing: OUTGOING,
  })

  it("passes when the operator approved the figures now being written", () => {
    expect(describeRetroPreviewMismatch(plan(), { totalAccrueCents: 1_000, totalReverseCents: 900 }))
      .toBeNull()
  })

  it("names both figures when the accrual total moved under the operator", () => {
    const message = describeRetroPreviewMismatch(plan(), { totalAccrueCents: 500, totalReverseCents: 900 })
    // Same formatter as the preview beside it — a thousands separator and a
    // non-breaking space, not a bespoke R1050.00.
    expect(message).toContain(zar(500))
    expect(message).toContain(zar(1_000))
  })

  it("catches a changed reversal total too", () => {
    expect(describeRetroPreviewMismatch(plan(), { totalAccrueCents: 1_000, totalReverseCents: 0 }))
      .toContain(zar(900))
  })
})

describe("describeRetroBlockers", () => {
  it("names the loan and the agent already paid on it", () => {
    const message = describeRetroBlockers([
      { kind: "PAID_ROW_EXISTS", loanReference: "LN-0001", agentName: "Outgoing Agent" },
    ])

    expect(message).toContain("LN-0001")
    expect(message).toContain("Outgoing Agent")
  })
})

describe("serialiseRetroPlan", () => {
  it("totals both sides so the preview cannot disagree with the write", () => {
    const plan = planRetroAttribution({
      candidates: [
        candidate({ loanId: "L1", loanReference: "LN-0001", principalCents: 100_000 }),
        candidate({ loanId: "L2", loanReference: "LN-0002", principalCents: 200_000 }),
        candidate({ loanId: "L3", loanReference: "LN-0003", loanStatus: "DEFAULTED" }),
      ],
      tenantCommissionBps: 100,
      events: [
        event({ id: "evt-a1", loanId: "L1", agentId: "agent-a", commissionStatus: "PENDING", commissionCents: 900 }),
      ],
      incomingAgentId: "agent-b",
      outgoing: OUTGOING,
    })

    expect(serialiseRetroPlan(plan)).toEqual({
      accrue: [
        { loanReference: "LN-0001", principalCents: 100_000, commissionCents: 1_000 },
        { loanReference: "LN-0002", principalCents: 200_000, commissionCents: 2_000 },
      ],
      reverse: [{ loanReference: "LN-0001", agentName: "Outgoing Agent", commissionCents: 900 }],
      skipped: [{ loanReference: "LN-0003", reason: "INELIGIBLE_LOAN_STATUS" }],
      blockers: [],
      totalAccrueCents: 3_000,
      totalReverseCents: 900,
      reverseUnknownCount: 0,
    })
  })
})
