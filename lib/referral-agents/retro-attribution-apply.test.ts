import { describe, it, expect, vi } from "vitest"
import { loadRetroAttributionPlan, applyRetroAttribution } from "./retro-attribution-apply"
import type { RetroPlan } from "./retro-attribution"

function makeDb(over: Record<string, unknown> = {}) {
  return {
    client: {
      findUnique: vi.fn().mockResolvedValue({
        firstName: "Thandi", lastName: "Nkosi", phone: "0821234567", email: null,
      }),
    },
    loan: {
      findMany: vi.fn().mockResolvedValue([
        { id: "L1", reference: "LN-0001", status: "ACTIVE", principal: 100_000, createdAt: new Date("2026-06-01T00:00:00Z") },
        { id: "L2", reference: "LN-0002", status: "COMPLETED", principal: 200_000, createdAt: new Date("2026-07-01T00:00:00Z") },
      ]),
    },
    tenantConfig: { findUnique: vi.fn().mockResolvedValue({ referralCommissionBps: 100 }) },
    referralCode: {
      // Honours a `status` filter, so a lookup that narrowed to ACTIVE would
      // actually lose the retired outgoing code the way it would in Postgres.
      findFirst: vi.fn().mockImplementation(async ({ where }: { where: { id: string; status?: string } }) => {
        const rows: Record<string, { id: string; agentId: string; status: string; agent: { displayName: string; status: string; commissionBps: number | null; phone: string | null; email: string | null } }> = {
          "code-b": { id: "code-b", agentId: "agent-b", status: "ACTIVE", agent: { displayName: "Agent Two", status: "ACTIVE", commissionBps: null, phone: null, email: null } },
          "code-a": { id: "code-a", agentId: "agent-a", status: "RETIRED", agent: { displayName: "Outgoing Agent", status: "SUSPENDED", commissionBps: null, phone: null, email: null } },
          // An ACTIVE agent whose CODE was retired, so the two gates are distinguishable.
          "code-retired": { id: "code-retired", agentId: "agent-c", status: "RETIRED", agent: { displayName: "Agent Three", status: "ACTIVE", commissionBps: null, phone: null, email: null } },
          "code-override": { id: "code-override", agentId: "agent-d", status: "ACTIVE", agent: { displayName: "Agent Four", status: "ACTIVE", commissionBps: 250, phone: null, email: null } },
          // Matches the borrower only by EMAIL, for the override test.
          "code-email": { id: "code-email", agentId: "agent-f", status: "ACTIVE", agent: { displayName: "Not Their Name", status: "ACTIVE", commissionBps: null, phone: null, email: "agent@example.invalid" } },
          // Same human as the borrower, reachable only through the phone number.
          "code-self": { id: "code-self", agentId: "agent-e", status: "ACTIVE", agent: { displayName: "Not Their Name", status: "ACTIVE", commissionBps: null, phone: "+27821234567", email: null } },
        }
        const row = rows[where.id]
        if (!row) return null
        return where.status && where.status !== row.status ? null : row
      }),
    },
    referralEvent: { findMany: vi.fn().mockResolvedValue([]) },
    ...over,
  }
}

describe("loadRetroAttributionPlan", () => {
  it("prices the client's whole loan book against the incoming agent", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: null,
    })

    expect(plan.accrue.map((a) => [a.loanReference, a.commissionCents])).toEqual([
      ["LN-0001", 1_000],
      ["LN-0002", 2_000],
    ])
    expect(plan.blockers).toEqual([])
  })

  // FIX-5. isSelfReferral compares the client against the agent, and the SAME
  // PUT may be changing the client's name, phone or email. Reading the stored
  // values let one request rename the client to match the agent and assign that
  // agent, evading the check entirely — a self-referral in a single edit.
  it("checks self-referral against the name the request will WRITE", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: null,
      subjectOverride: { firstName: "Agent", lastName: "Two" },
    })

    expect(plan.accrue).toEqual([])
    expect(plan.skipped.map((s) => s.reason)).toEqual(["SELF_REFERRAL", "SELF_REFERRAL"])
  })

  it("checks self-referral against the phone the request will WRITE", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-self", previousCodeId: null,
      // Stored phone matches the agent; this request moves it away, so the
      // heuristic must NOT fire on a number the client will no longer have.
      subjectOverride: { phone: "0839999999" },
    })

    expect(plan.skipped.map((s) => s.reason)).not.toContain("SELF_REFERRAL")
  })

  it("checks self-referral against the email the request will WRITE", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-email", previousCodeId: null,
      subjectOverride: { email: "agent@example.invalid" },
    })

    expect(plan.skipped.map((s) => s.reason)).toEqual(["SELF_REFERRAL", "SELF_REFERRAL"])
  })

  // An override carrying only SOME fields must not blank the others — a request
  // that changes a phone number says nothing about the name.
  it("falls back to the stored value for every field the request omits", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-self", previousCodeId: null,
      subjectOverride: { firstName: "Renamed" },
    })

    // Stored phone still matches the agent's, so the check still fires.
    expect(plan.skipped.map((s) => s.reason)).toEqual(["SELF_REFERRAL", "SELF_REFERRAL"])
  })

  // NEW-1. The verification is scoped to the payee, so the plan has to resolve
  // and carry the incoming agent's id — not just their display name.
  it("names the incoming agent's id on every accrual", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: null,
    })

    expect(plan.accrue.map((a) => a.agentId)).toEqual(["agent-b", "agent-b"])
  })

  it("carries the ids of the rows it read, for the write to exclude", async () => {
    const db = makeDb({
      referralEvent: {
        findMany: vi.fn().mockResolvedValue([
          { id: "evt-a1", agentId: "agent-a", commissionStatus: "PENDING", commissionCents: 900, metadata: { loanId: "L1" } },
        ]),
      },
    })
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: "code-a",
    })

    expect(plan.knownEventIds).toEqual(["evt-a1"])
  })

  // Every read is another tenant's commission if it is not scoped. Asserted per
  // query rather than once, because each is a separate place to forget it.
  it("scopes every read to the tenant", async () => {
    const db = makeDb()
    await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: "code-a",
    })

    expect(db.client.findUnique.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" })
    expect(db.loan.findMany.mock.calls[0][0].where).toMatchObject({ tenantId: "t1" })
    // CONVERTED too: a CLICK or WHATSAPP_START row carries no commission and
    // reversing one would corrupt the attribution funnel, not the ledger.
    expect(db.referralEvent.findMany.mock.calls[0][0].where)
      .toMatchObject({ tenantId: "t1", eventType: "CONVERTED" })
    for (const call of db.referralCode.findFirst.mock.calls) {
      expect(call[0].where).toMatchObject({ tenantId: "t1" })
    }
  })

  // A move that is not a move must not reverse and re-accrue the SAME agent's
  // rows. planReferralUpdate already classifies this as "unchanged"; belt and
  // braces, because the preview route has no such classification in front of it.
  it("plans nothing when the incoming code is the one already on file", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: "code-b",
    })

    expect(plan).toEqual({ accrue: [], reverse: [], skipped: [], blockers: [], knownEventIds: [] })
    expect(db.loan.findMany).not.toHaveBeenCalled()
  })

  // The outgoing agent may since have been suspended or their code retired. Their
  // live rows still have to be clawed back, so the lookup must not filter on
  // ACTIVE the way resolveReferralCodeById does.
  it("reverses a suspended outgoing agent's live rows", async () => {
    const db = makeDb({
      referralEvent: {
        findMany: vi.fn().mockResolvedValue([
          { id: "evt-a1", agentId: "agent-a", commissionStatus: "PENDING", commissionCents: 900, metadata: { loanId: "L1" } },
        ]),
      },
    })
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: "code-a",
    })

    expect(plan.reverse).toMatchObject([{
      eventId: "evt-a1", loanId: "L1", loanReference: "LN-0001",
      agentName: "Outgoing Agent", commissionCents: 900,
    }])
    expect(plan.accrue.map((a) => a.loanReference)).toEqual(["LN-0001", "LN-0002"])
  })

  // The marker a LATER move reads to tell this reversal from a clawback lives in
  // the row's metadata, so the loader has to carry metadata into the planner.
  it("carries each row's metadata through to the planner", async () => {
    const db = makeDb({
      referralEvent: {
        findMany: vi.fn().mockResolvedValue([
          {
            id: "evt-a1", agentId: "agent-a", commissionStatus: "REVERSED", commissionCents: 900,
            metadata: { loanId: "L1", reversalReason: "RE_ATTRIBUTION" },
          },
        ]),
      },
    })
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: "code-a",
    })

    // Read as a re-attribution reversal, not a clawback: LN-0001 still accrues.
    expect(plan.accrue.map((a) => a.loanReference)).toEqual(["LN-0001", "LN-0002"])
    expect(plan.accrue[0].supersedesReversedPrior).toBe(true)
  })

  it("selects the metadata column it needs to read the marker from", async () => {
    const db = makeDb()
    await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: "code-a",
    })

    expect(db.referralEvent.findMany.mock.calls[0][0].select)
      .toMatchObject({ metadata: true })
  })

  // The status is read from the row, never assumed. Hardcoding it ACTIVE would
  // silently defeat planCommissionBackfill's CODE_NOT_ACTIVE gate and accrue on
  // a retired code the PUT would separately have refused.
  it("reports a retired incoming code as CODE_NOT_ACTIVE rather than accruing", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-retired", previousCodeId: null,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.skipped.map((s) => s.reason)).toEqual(["CODE_NOT_ACTIVE", "CODE_NOT_ACTIVE"])
  })

  it("reports a suspended incoming agent as AGENT_NOT_ACTIVE rather than accruing", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-a", previousCodeId: null,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.skipped.map((s) => s.reason)).toEqual(["AGENT_NOT_ACTIVE", "AGENT_NOT_ACTIVE"])
  })

  it("prices at the agent's own rate when they have an override", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-override", previousCodeId: null,
    })

    expect(plan.accrue.map((a) => a.commissionCents)).toEqual([2_500, 5_000])
  })

  // isSelfReferral compares phone and email, not just the name — so both have to
  // reach it, or an agent under a different name earns on their own loan.
  it("carries the agent's contact details into the self-referral check", async () => {
    const db = makeDb()
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-self", previousCodeId: null,
    })

    expect(plan.accrue).toEqual([])
    expect(plan.skipped.map((s) => s.reason)).toEqual(["SELF_REFERRAL", "SELF_REFERRAL"])
  })

  it("ignores a commission row whose metadata carries no loan id", async () => {
    const db = makeDb({
      referralEvent: {
        findMany: vi.fn().mockResolvedValue([
          { id: "evt-junk", agentId: "agent-a", commissionStatus: "PENDING", commissionCents: 900, metadata: null },
        ]),
      },
    })
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: "code-a",
    })

    expect(plan.reverse).toEqual([])
  })

  it("plans only reversals when the agent is cleared", async () => {
    const db = makeDb({
      referralEvent: {
        findMany: vi.fn().mockResolvedValue([
          { id: "evt-a1", agentId: "agent-a", commissionStatus: "PENDING", commissionCents: 900, metadata: { loanId: "L1" } },
        ]),
      },
    })
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: null, previousCodeId: "code-a",
    })

    expect(plan.reverse).toHaveLength(1)
    expect(plan.accrue).toEqual([])
  })

  // The commission lookup ORs one filter per loan; with no loans that is an
  // empty OR, so it must not be issued at all.
  it("plans nothing, and asks nothing, for a client with no loans", async () => {
    const db = makeDb({ loan: { findMany: vi.fn().mockResolvedValue([]) } })
    const plan = await loadRetroAttributionPlan(db as never, {
      tenantId: "t1", clientId: "c1", incomingCodeId: "code-b", previousCodeId: "code-a",
    })

    expect(plan).toEqual({ accrue: [], reverse: [], skipped: [], blockers: [], knownEventIds: [] })
    expect(db.referralEvent.findMany).not.toHaveBeenCalled()
  })
})

describe("applyRetroAttribution", () => {
  const ACTOR = { userId: "staff-1", userEmail: "admin@example.invalid" }

  function makeTx(over: Record<string, unknown> = {}) {
    return {
      referralEvent: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue({ id: "evt-new", commissionCents: 1_000 }),
        create: vi.fn().mockResolvedValue({ id: "evt-new" }),
      },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
      ...over,
    }
  }

  function plan(over: Partial<RetroPlan> = {}): RetroPlan {
    return {
      accrue: [{
        loanId: "L1", loanReference: "LN-0001", loanStatus: "ACTIVE", loanCreatedAt: "2026-06-01",
        principalCents: 100_000, clientId: "c1", clientName: "Thandi Nkosi",
        clientPhone: null, clientEmail: null,
        agentId: "agent-b", agentName: "Agent Two",
        agentPhone: null, agentEmail: null, agentStatus: "ACTIVE", agentCommissionBps: null,
        codeValue: "CODE-B", codeStatus: "ACTIVE", bps: 100, commissionCents: 1_000,
        supersedesReversedPrior: true,
      }],
      reverse: [{
        eventId: "evt-a1", loanId: "L1", loanReference: "LN-0001",
        agentName: "Outgoing Agent", commissionCents: 900,
        metadata: { loanId: "L1", bps: 100, reversalReason: "RE_ATTRIBUTION" },
      }],
      skipped: [],
      blockers: [],
      knownEventIds: ["evt-a1"],
      ...over,
    }
  }

  it("reverses the outgoing rows and accrues for the incoming agent", async () => {
    const tx = makeTx()
    const record = vi.fn().mockResolvedValue(undefined)
    const result = await applyRetroAttribution(tx as never, {
      tenantId: "t1", clientId: "c1", plan: plan(), actor: ACTOR,
    }, record)

    // The marker is written in the SAME statement that flips the status, so a
    // reversal can never land unmarked and be misread as a clawback later.
    expect(tx.referralEvent.updateMany).toHaveBeenCalledWith({
      where: { id: "evt-a1", tenantId: "t1", commissionStatus: { in: ["PENDING", "PAYABLE"] } },
      data: {
        commissionStatus: "REVERSED",
        metadata: { loanId: "L1", bps: 100, reversalReason: "RE_ATTRIBUTION" },
      },
    })
    expect(result).toMatchObject({
      reversed: 1, accrued: 1, totalReverseCents: 900, totalAccrueCents: 1_000,
      reverseUnknownCount: 0,
    })
  })

  // Driven by the PLAN's own flag, not re-derived from the reversal set: a prior
  // reversed on an EARLIER move must be superseded even though this transaction
  // reverses nothing for that loan.
  it("supersedes exactly where the plan says to", async () => {
    const tx = makeTx()
    const record = vi.fn().mockResolvedValue(undefined)
    await applyRetroAttribution(tx as never, {
      tenantId: "t1",
      clientId: "c1",
      plan: plan({
        reverse: [],
        accrue: [
          { ...plan().accrue[0], supersedesReversedPrior: true },
          { ...plan().accrue[0], loanId: "L2", loanReference: "LN-0002", supersedesReversedPrior: false },
        ],
      }),
      actor: ACTOR,
    }, record)

    expect(record.mock.calls[0][1]).toMatchObject({ loanId: "L1", supersedeReversedPriors: true })
    expect(record.mock.calls[1][1]).not.toHaveProperty("supersedeReversedPriors")
  })

  // NEW-1, end to end: the verification the accrual runs must be scoped to the
  // planned payee AND exclude every row the plan already saw, so it cannot be
  // satisfied by another agent's row or by one that predates this write.
  it("verifies against the planned agent, excluding the rows the plan saw", async () => {
    const tx = makeTx()
    await applyRetroAttribution(tx as never, {
      tenantId: "t1",
      clientId: "c1",
      plan: plan({ knownEventIds: ["evt-a1", "evt-other"] }),
      actor: ACTOR,
    }, vi.fn())

    expect(tx.referralEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        agentId: "agent-b",
        id: { notIn: ["evt-a1", "evt-other"] },
      }),
    }))
  })

  // MED-5. A move that accrued nothing because every loan was excluded must be
  // distinguishable in the audit trail from one that had nothing to do.
  it("returns the skipped set and its reasons for the audit trail", async () => {
    const tx = makeTx()
    const result = await applyRetroAttribution(tx as never, {
      tenantId: "t1",
      clientId: "c1",
      plan: plan({
        accrue: [],
        reverse: [],
        skipped: [
          { ...plan().accrue[0], loanReference: "LN-0003", reason: "CLAWED_BACK" },
          { ...plan().accrue[0], loanReference: "LN-0004", reason: "INELIGIBLE_LOAN_STATUS" },
        ],
      }),
      actor: ACTOR,
    }, vi.fn())

    expect(result).toEqual({
      reversed: 0, accrued: 0, totalReverseCents: 0, totalAccrueCents: 0,
      reverseUnknownCount: 0,
      skipped: [
        { loanReference: "LN-0003", reason: "CLAWED_BACK" },
        { loanReference: "LN-0004", reason: "INELIGIBLE_LOAN_STATUS" },
      ],
    })
  })

  // A reversal that leaves no trace is the same defect in the other direction.
  it("writes one audit row naming every reversed event", async () => {
    const tx = makeTx()
    await applyRetroAttribution(tx as never, {
      tenantId: "t1", clientId: "c1", plan: plan(), actor: ACTOR,
    }, vi.fn())

    const reversal = tx.auditLog.create.mock.calls
      .map((call) => call[0].data)
      .find((data: { action: string }) => data.action === "REFERRAL_COMMISSION_RETRO_REVERSED")
    expect(reversal).toMatchObject({
      tenantId: "t1",
      userId: "staff-1",
      userEmail: "admin@example.invalid",
      entity: "Client",
      entityId: "c1",
    })
    expect(reversal.oldValue.reversed).toEqual([
      { eventId: "evt-a1", loanReference: "LN-0001", agentName: "Outgoing Agent", commissionCents: 900 },
    ])
  })

  // NEW-3. The audit trail must not record an amount the row never carried.
  it("audits an unrecorded reversal amount as null, never as zero", async () => {
    const tx = makeTx()
    await applyRetroAttribution(tx as never, {
      tenantId: "t1",
      clientId: "c1",
      plan: plan({
        accrue: [],
        reverse: [{ ...plan().reverse[0], commissionCents: null }],
      }),
      actor: ACTOR,
    }, vi.fn())

    const reversal = tx.auditLog.create.mock.calls
      .map((call) => call[0].data)
      .find((data: { action: string }) => data.action === "REFERRAL_COMMISSION_RETRO_REVERSED")
    expect(reversal.oldValue.reversed[0].commissionCents).toBeNull()
    expect(reversal.newValue.reverseUnknownCount).toBe(1)
  })

  it("stamps the accrual audit rows with the re-attribution action and the actor", async () => {
    const tx = makeTx()
    await applyRetroAttribution(tx as never, {
      tenantId: "t1", clientId: "c1", plan: plan({ reverse: [] }), actor: ACTOR,
    }, vi.fn())

    const accrual = tx.auditLog.create.mock.calls
      .map((call) => call[0].data)
      .find((data: { action: string }) => data.action === "REFERRAL_COMMISSION_RETRO_ACCRUED")
    expect(accrual.userId).toBe("staff-1")
    expect(accrual.newValue.reason).toContain("Agent Two")
  })

  // The reversal is a conditional update: if collections clawed the row back
  // between the plan and the write, it matches nothing and the whole edit must
  // roll back rather than accrue for the incoming agent on a stale picture.
  it("throws when a row it planned to reverse has moved underneath it", async () => {
    const tx = makeTx({
      referralEvent: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        findFirst: vi.fn(),
        create: vi.fn(),
      },
    })

    await expect(applyRetroAttribution(tx as never, {
      tenantId: "t1", clientId: "c1", plan: plan(), actor: ACTOR,
    }, vi.fn())).rejects.toThrow(/concurrently/i)
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  it("touches nothing for an empty plan", async () => {
    const tx = makeTx()
    const record = vi.fn()
    const result = await applyRetroAttribution(tx as never, {
      tenantId: "t1", clientId: "c1",
      plan: { accrue: [], reverse: [], skipped: [], blockers: [], knownEventIds: [] },
      actor: ACTOR,
    }, record)

    expect(tx.referralEvent.updateMany).not.toHaveBeenCalled()
    expect(tx.auditLog.create).not.toHaveBeenCalled()
    expect(record).not.toHaveBeenCalled()
    expect(result).toEqual({
      reversed: 0, accrued: 0, totalReverseCents: 0, totalAccrueCents: 0,
      reverseUnknownCount: 0, skipped: [],
    })
  })
})
