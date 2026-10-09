import { applyBackfillAccrual, type BackfillCandidate } from "./commission-backfill"
import {
  planRetroAttribution,
  REVERSIBLE_COMMISSION_STATUSES,
  type RetroPlan,
} from "./retro-attribution"

// The I/O half of manual re-attribution: assemble the plan from the database,
// and apply it. The decisions themselves live in ./retro-attribution, which is
// pure. Both the PUT that writes and the GET that previews call
// `loadRetroAttributionPlan`, so the rand figure an operator signs off on is
// computed by the same code that writes it.

type ReferralCodeRow = {
  id: string
  agentId: string
  status: string
  agent: {
    displayName: string
    status: string
    commissionBps: number | null
    phone: string | null
    email: string | null
  }
} | null

export type RetroReadClient = {
  client: { findUnique(args: unknown): Promise<unknown> }
  loan: { findMany(args: unknown): Promise<unknown> }
  tenantConfig: { findUnique(args: unknown): Promise<unknown> }
  referralCode: { findFirst(args: unknown): Promise<unknown> }
  referralEvent: { findMany(args: unknown): Promise<unknown> }
}

const EMPTY_PLAN: RetroPlan = { accrue: [], reverse: [], skipped: [], blockers: [], knownEventIds: [] }

function metadataRecord(metadata: unknown): Record<string, unknown> | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null
  return metadata as Record<string, unknown>
}

function metadataLoanId(metadata: unknown): string | null {
  const loanId = metadataRecord(metadata)?.loanId
  return typeof loanId === "string" ? loanId : null
}

/**
 * Look a referral code up WITHOUT requiring it to be active.
 *
 * Deliberately not `resolveReferralCodeById`, which filters on ACTIVE:
 * the outgoing agent may since have been suspended, and their live rows still
 * have to be clawed back. For the incoming agent the status is read and then
 * GATED by the planner (AGENT_NOT_ACTIVE / CODE_NOT_ACTIVE), so a retired code
 * yields a stated reason in the preview rather than a silent nothing. The PUT
 * separately refuses an inactive incoming code outright.
 */
async function readCode(
  db: RetroReadClient,
  opts: { tenantId: string; id: string | null },
): Promise<ReferralCodeRow> {
  if (!opts.id) return null
  return (await db.referralCode.findFirst({
    where: { id: opts.id, tenantId: opts.tenantId },
    select: {
      id: true,
      agentId: true,
      status: true,
      agent: {
        select: { displayName: true, status: true, commissionBps: true, phone: true, email: true },
      },
    },
  })) as ReferralCodeRow
}

/**
 * Build the plan for re-pointing one client's referral attribution.
 *
 * Reads the client's WHOLE loan book, not the eligible subset: the planner has
 * to report why a loan was left out, and the outgoing agent's rows are keyed to
 * loans that may themselves be ineligible.
 */
export async function loadRetroAttributionPlan(
  db: RetroReadClient,
  opts: {
    tenantId: string
    clientId: string
    incomingCodeId: string | null
    previousCodeId: string | null
    /**
     * The identity fields THIS request will write, for the ones it carries.
     *
     * `isSelfReferral` compares the client against the agent, and the same PUT
     * may be renaming the client or changing their phone/email. Reading only
     * what is on file let one request rename a client to match an agent and
     * assign that agent in a single edit, evading the check. Keys the request
     * omits fall back to the stored value — changing a phone number says
     * nothing about the name.
     */
    subjectOverride?: {
      firstName?: string
      lastName?: string
      phone?: string | null
      email?: string | null
    }
  },
): Promise<RetroPlan> {
  const { tenantId, clientId, incomingCodeId, previousCodeId, subjectOverride } = opts
  // Not a move. Reversing and re-accruing the same code's rows would churn the
  // ledger for no change of payee.
  if (incomingCodeId === previousCodeId) return EMPTY_PLAN

  const client = (await db.client.findUnique({
    where: { id: clientId, tenantId },
    select: { firstName: true, lastName: true, phone: true, email: true },
  })) as { firstName: string; lastName: string; phone: string | null; email: string | null } | null
  if (!client) return EMPTY_PLAN

  const loans = (await db.loan.findMany({
    where: { tenantId, clientId },
    select: { id: true, reference: true, status: true, principal: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  })) as { id: string; reference: string; status: string; principal: number; createdAt: Date }[]
  if (loans.length === 0) return EMPTY_PLAN

  const [incoming, outgoing, tenantConfig] = await Promise.all([
    readCode(db, { tenantId, id: incomingCodeId }),
    readCode(db, { tenantId, id: previousCodeId }),
    db.tenantConfig.findUnique({
      where: { tenantId },
      select: { referralCommissionBps: true },
    }) as Promise<{ referralCommissionBps: number } | null>,
  ])

  // No JSON `in` filter exists for a path, so the loan ids are OR'd. Bounded by
  // one client's loan count, which is small.
  const rows = (await db.referralEvent.findMany({
    where: {
      tenantId,
      eventType: "CONVERTED",
      OR: loans.map((loan) => ({ metadata: { path: ["loanId"], equals: loan.id } })),
    },
    select: { id: true, agentId: true, commissionStatus: true, commissionCents: true, metadata: true },
  })) as {
    id: string
    agentId: string | null
    commissionStatus: string
    commissionCents: number | null
    metadata: unknown
  }[]

  // The values the request will LEAVE BEHIND, not the ones it found.
  const subject = {
    firstName: subjectOverride?.firstName ?? client.firstName,
    lastName: subjectOverride?.lastName ?? client.lastName,
    phone: subjectOverride?.phone !== undefined ? subjectOverride.phone : client.phone,
    email: subjectOverride?.email !== undefined ? subjectOverride.email : client.email,
  }
  const clientName = `${subject.firstName} ${subject.lastName}`.trim()
  const candidates: BackfillCandidate[] = loans.map((loan) => ({
    loanId: loan.id,
    loanReference: loan.reference,
    loanStatus: String(loan.status),
    loanCreatedAt: loan.createdAt.toISOString().slice(0, 10),
    principalCents: loan.principal,
    clientId,
    clientName,
    clientPhone: subject.phone,
    clientEmail: subject.email,
    agentId: incoming?.agentId ?? null,
    agentName: incoming?.agent.displayName ?? "(no agent)",
    agentPhone: incoming?.agent.phone ?? null,
    agentEmail: incoming?.agent.email ?? null,
    agentStatus: incoming?.agent.status ?? "MISSING",
    agentCommissionBps: incoming?.agent.commissionBps ?? null,
    codeValue: incomingCodeId ?? "(none)",
    // Read, never assumed: hardcoding this ACTIVE would silently defeat
    // planCommissionBackfill's CODE_NOT_ACTIVE gate.
    codeStatus: incoming?.status ?? "MISSING",
  }))

  return planRetroAttribution({
    candidates,
    tenantCommissionBps: tenantConfig?.referralCommissionBps ?? 0,
    events: rows
      .map((row) => ({
        id: row.id,
        loanId: metadataLoanId(row.metadata),
        agentId: row.agentId,
        commissionStatus: row.commissionStatus,
        commissionCents: row.commissionCents,
        metadata: metadataRecord(row.metadata),
      }))
      // A CONVERTED row with no loan id in its metadata cannot be attributed to
      // a loan, so it is neither reversed nor treated as blocking.
      .filter((row): row is typeof row & { loanId: string } => row.loanId !== null),
    incomingAgentId: incoming?.agentId ?? null,
    outgoing: outgoing ? { agentId: outgoing.agentId, agentName: outgoing.agent.displayName } : null,
  })
}

export type RetroWriteClient = {
  referralEvent: {
    updateMany(args: unknown): Promise<unknown>
    findFirst(args: unknown): Promise<unknown>
  }
  auditLog: { create(args: unknown): Promise<unknown> }
}

export type RetroAttributionOutcome = {
  reversed: number
  accrued: number
  /** KNOWN amounts only — see `reverseUnknownCount`. */
  totalReverseCents: number
  /** Reversals whose amount the row never recorded, so the total above is not
   *  mistaken for a complete figure in the audit trail. */
  reverseUnknownCount: number
  totalAccrueCents: number
  /** Every loan this move deliberately did NOT credit, with the reason. Recorded
   *  so a re-attribution that accrued nothing because everything was excluded is
   *  distinguishable in the audit trail from one that had nothing to do. */
  skipped: { loanReference: string; reason: string }[]
}

/**
 * Apply a plan inside the caller's transaction.
 *
 * Everything here runs in the transaction that also writes
 * `Client.referralCodeId`, so a failure rolls the client edit back too.
 * A client pointed at a new agent with no accrual written is the state this
 * removes, not one to fall back to.
 */
export async function applyRetroAttribution<Tx extends RetroWriteClient>(
  tx: Tx,
  opts: {
    tenantId: string
    clientId: string
    plan: RetroPlan
    actor: { userId: string; userEmail: string }
  },
  // Injected, exactly as the backfill injects it, so the accrual cannot drift
  // from the gates the live disbursement path applies.
  recordAccrual: (tx: Tx, accrual: {
    tenantId: string; loanId: string; clientId: string; principalCents: number
    supersedeReversedPriors?: boolean
  }) => Promise<void>,
): Promise<RetroAttributionOutcome> {
  const { tenantId, clientId, plan, actor } = opts

  for (const reversal of plan.reverse) {
    // Conditional on the status the plan saw. If collections clawed the row back
    // in between, this matches nothing and the whole edit rolls back rather than
    // accruing for the incoming agent on a stale picture.
    const moved = (await tx.referralEvent.updateMany({
      where: {
        id: reversal.eventId,
        tenantId,
        // An `in` on LIVE MONEY, matching the planner's rule exactly. Still a
        // conditional update, so a row that turned PAID — or that a LOAN_ADMIN
        // BLOCKED — between the plan and this write matches nothing, and the
        // whole edit rolls back rather than reversing a decision it never saw.
        commissionStatus: { in: [...REVERSIBLE_COMMISSION_STATUSES] },
      },
      // The marker lands in the SAME statement that flips the status, so a
      // reversal can never be left unmarked and misread as a clawback by a later
      // move. The plan merged it onto the row's existing metadata.
      data: { commissionStatus: "REVERSED", metadata: reversal.metadata },
    })) as { count: number }
    if (moved.count !== 1) {
      throw new Error(
        `${reversal.loanReference}: commission for ${reversal.agentName} changed concurrently; refresh and try again`,
      )
    }
  }

  if (plan.reverse.length > 0) {
    await tx.auditLog.create({
      data: {
        tenantId,
        userId: actor.userId,
        userEmail: actor.userEmail,
        action: "REFERRAL_COMMISSION_RETRO_REVERSED",
        entity: "Client",
        entityId: clientId,
        oldValue: {
          reversed: plan.reverse.map((r) => ({
            eventId: r.eventId,
            loanReference: r.loanReference,
            agentName: r.agentName,
            commissionCents: r.commissionCents,
          })),
        },
        newValue: {
          commissionStatus: "REVERSED",
          reason: "Referral agent re-attributed on the client record",
          // Stated, so the totals above are not read as a complete figure when
          // some of the rows never recorded an amount.
          reverseUnknownCount: plan.reverse.filter((r) => r.commissionCents === null).length,
        },
      },
    })
  }

  for (const accrual of plan.accrue) {
    await applyBackfillAccrual(
      tx,
      {
        tenantId,
        loanId: accrual.loanId,
        clientId,
        loanReference: accrual.loanReference,
        agentId: accrual.agentId,
        agentName: accrual.agentName,
        principalCents: accrual.principalCents,
        bps: accrual.bps,
        commissionCents: accrual.commissionCents,
      },
      actor.userEmail,
      recordAccrual,
      {
        // The PLAN decides, not the reversal set: a prior reversed by an EARLIER
        // re-attribution must be superseded too, and this transaction reverses
        // nothing for that loan. The planner only ever sets this where every
        // reversed row on the loan is a re-attribution — a default clawback
        // still blocks.
        supersedeReversedPriors: accrual.supersedesReversedPrior,
        auditAction: "REFERRAL_COMMISSION_RETRO_ACCRUED",
        reason: `Referral agent re-attributed to ${accrual.agentName} on the client record`,
        userId: actor.userId,
        // Every CONVERTED row this move ALREADY saw for the client's loans, so
        // the verification can only be satisfied by a row this transaction
        // actually created. Loaded with the plan — no extra query.
        knownPriorEventIds: plan.knownEventIds,
      },
    )
  }

  return {
    reversed: plan.reverse.length,
    accrued: plan.accrue.length,
    // KNOWN amounts only; commissionCents is Int? and an unrecorded amount is
    // reported as such rather than added in as a zero.
    totalReverseCents: plan.reverse.reduce((sum, r) => sum + (r.commissionCents ?? 0), 0),
    reverseUnknownCount: plan.reverse.filter((r) => r.commissionCents === null).length,
    totalAccrueCents: plan.accrue.reduce((sum, a) => sum + a.commissionCents, 0),
    skipped: plan.skipped.map((s) => ({ loanReference: s.loanReference, reason: s.reason })),
  }
}
