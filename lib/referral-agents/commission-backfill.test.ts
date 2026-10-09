import { describe, it, expect, vi } from "vitest"
import { planCommissionBackfill, backfillOutcome, applyBackfillAccrual, BACKFILL_ELIGIBLE_LOAN_STATUSES } from "./commission-backfill"

function candidate(over: Partial<Parameters<typeof planCommissionBackfill>[0][number]> = {}) {
  return {
    loanId: "L1",
    loanReference: "LN-0001",
    loanStatus: "ACTIVE",
    loanCreatedAt: "2026-07-01",
    principalCents: 100_000,
    clientId: "client-1",
    clientName: "Test Client",
    clientPhone: null as string | null,
    clientEmail: null as string | null,
    agentId: "agent-1",
    agentName: "Test Agent",
    agentPhone: null as string | null,
    agentEmail: null as string | null,
    agentStatus: "ACTIVE",
    agentCommissionBps: null as number | null,
    codeValue: "CODE1",
    codeStatus: "ACTIVE",
    ...over,
  }
}

describe("planCommissionBackfill", () => {
  it("accrues at the tenant default when the agent has no override", () => {
    const { accrue, skipped } = planCommissionBackfill([candidate()], 100)
    expect(skipped).toEqual([])
    expect(accrue).toHaveLength(1)
    expect(accrue[0]).toMatchObject({ loanId: "L1", bps: 100, commissionCents: 1_000 })
  })

  it("prefers an explicit agent override over the tenant default", () => {
    const { accrue } = planCommissionBackfill([candidate({ agentCommissionBps: 250 })], 100)
    expect(accrue[0]).toMatchObject({ bps: 250, commissionCents: 2_500 })
  })

  // An agent override of 0 is a deliberate "this agent earns nothing", and must
  // NOT fall through to the tenant default.
  it("treats an agent override of 0 as deliberate, not absent", () => {
    const { accrue, skipped } = planCommissionBackfill([candidate({ agentCommissionBps: 0 })], 100)
    expect(accrue).toEqual([])
    expect(skipped[0]).toMatchObject({ reason: "ZERO_RATE" })
  })

  it("skips every loan when the tenant default is 0 and no agent overrides", () => {
    const { accrue, skipped } = planCommissionBackfill([candidate()], 0)
    expect(accrue).toEqual([])
    expect(skipped[0]).toMatchObject({ reason: "ZERO_RATE" })
  })

  it("skips a suspended agent", () => {
    const { accrue, skipped } = planCommissionBackfill([candidate({ agentStatus: "SUSPENDED" })], 100)
    expect(accrue).toEqual([])
    expect(skipped[0]).toMatchObject({ reason: "AGENT_NOT_ACTIVE" })
  })

  it("skips a retired code", () => {
    const { accrue, skipped } = planCommissionBackfill([candidate({ codeStatus: "RETIRED" })], 100)
    expect(accrue).toEqual([])
    expect(skipped[0]).toMatchObject({ reason: "CODE_NOT_ACTIVE" })
  })

  // Allow-list, not deny-list: a loan status added to the schema later must
  // default to "not paid out" until someone decides otherwise.
  it("uses an allow-list of loan statuses", () => {
    expect([...BACKFILL_ELIGIBLE_LOAN_STATUSES].sort()).toEqual(["ACTIVE", "COMPLETED", "RESTRUCTURED"])
  })

  it.each(["DEFAULTED", "WRITTEN_OFF", "PENDING_WRITE_OFF", "CANCELLED", "SOME_FUTURE_STATUS"])(
    "skips a %s loan rather than paying commission on it",
    (loanStatus) => {
      const { accrue, skipped } = planCommissionBackfill([candidate({ loanStatus })], 100)
      expect(accrue).toEqual([])
      expect(skipped[0]).toMatchObject({ reason: "INELIGIBLE_LOAN_STATUS" })
    },
  )

  it("rounds the commission to the nearest cent", () => {
    // 12345 * 100 / 10000 = 123.45 -> 123
    const { accrue } = planCommissionBackfill([candidate({ principalCents: 12_345 })], 100)
    expect(accrue[0].commissionCents).toBe(123)
  })

  it("reports every skip, so nothing is silently dropped", () => {
    const { accrue, skipped } = planCommissionBackfill([
      candidate({ loanId: "ok" }),
      candidate({ loanId: "defaulted", loanStatus: "DEFAULTED" }),
      candidate({ loanId: "suspended", agentStatus: "SUSPENDED" }),
    ], 100)
    expect(accrue.map((a) => a.loanId)).toEqual(["ok"])
    expect(skipped.map((s) => s.loanId).sort()).toEqual(["defaulted", "suspended"])
  })

  it("totals nothing for an empty candidate set", () => {
    expect(planCommissionBackfill([], 100)).toEqual({ accrue: [], skipped: [] })
  })
})

describe("backfillOutcome", () => {
  it("is ACCRUE when there is anything to write", () => {
    expect(backfillOutcome(planCommissionBackfill([candidate()], 100))).toBe("ACCRUE")
  })

  it("is RATE_OFF when candidates were skipped for a zero rate", () => {
    expect(backfillOutcome(planCommissionBackfill([candidate()], 0))).toBe("RATE_OFF")
  })

  // Regression: with the rate correctly set and the only remaining loan
  // DEFAULTED, the script used to abort with "commission is still switched off",
  // sending an operator to change a setting that was already right.
  it("is NOTHING_ELIGIBLE when the rate is fine but every loan is ineligible", () => {
    const plan = planCommissionBackfill([candidate({ loanStatus: "DEFAULTED" })], 100)
    expect(backfillOutcome(plan)).toBe("NOTHING_ELIGIBLE")
  })

  it("is NOTHING_ELIGIBLE when there are no candidates at all", () => {
    expect(backfillOutcome(planCommissionBackfill([], 100))).toBe("NOTHING_ELIGIBLE")
  })

  // A zero rate anywhere in the batch is still worth surfacing as the error.
  it("prefers RATE_OFF when both causes are present", () => {
    const plan = planCommissionBackfill([
      candidate({ loanId: "defaulted", loanStatus: "DEFAULTED" }),
      candidate({ loanId: "zero", agentCommissionBps: 0 }),
    ], 100)
    expect(backfillOutcome(plan)).toBe("RATE_OFF")
  })
})

// FIX-7. The backfill sweeps every tenant, so the prior-row ids it hands the
// verification have to be scoped per tenant: the accrual they guard is already
// tenant-scoped, so another tenant's ids add nothing but bind parameters — and
// they go into a `notIn` on EVERY loop iteration. Correct either way today,
// unbounded as the table grows.
describe("applyBackfillAccrual", () => {
  const planned = {
    tenantId: "t1", loanId: "L1", clientId: "c1", loanReference: "LN-0001",
    agentId: "agent-1",
    agentName: "Test Agent", principalCents: 100_000, bps: 100, commissionCents: 1_000,
  }

  function makeTx(event: { id: string; commissionCents: number | null } | null) {
    return {
      referralEvent: { findFirst: vi.fn().mockResolvedValue(event) },
      auditLog: { create: vi.fn().mockResolvedValue({ id: "audit-1" }) },
    }
  }

  it("writes an audit row keyed to the event the accrual actually created", async () => {
    const tx = makeTx({ id: "evt-1", commissionCents: 1_000 })
    const record = vi.fn().mockResolvedValue(undefined)
    const result = await applyBackfillAccrual(tx as never, planned, "ops@example.invalid", record)

    expect(result).toEqual({ eventId: "evt-1", commissionCents: 1_000 })
    expect(record).toHaveBeenCalledWith(tx, {
      tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 100_000,
    })
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entityId: "evt-1",
        userId: null,
        userEmail: "ops@example.invalid",
        action: "REFERRAL_COMMISSION_BACKFILLED",
      }),
    })
  })

  // The accrual function returns void whether it wrote or declined its own gates.
  it("throws when the accrual silently declined, so nothing commits", async () => {
    const tx = makeTx(null)
    await expect(applyBackfillAccrual(tx as never, planned, "ops@example.invalid", vi.fn()))
      .rejects.toThrow(/declined/i)
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  // REGRESSION: the audit row previously recorded the PLANNED amount even when
  // the accrual wrote a different one, putting a factually wrong figure into a
  // compliance trail on the exact path built to detect the disagreement.
  it("throws rather than auditing a planned amount the accrual did not write", async () => {
    const tx = makeTx({ id: "evt-1", commissionCents: 500 })
    await expect(applyBackfillAccrual(tx as never, planned, "ops@example.invalid", vi.fn()))
      .rejects.toThrow(/R 5\.00.*R 10\.00|R 10\.00.*R 5\.00/)
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  // FIX-C. The bespoke helper rendered R105000.00 with no thousands separator.
  // This message reaches SERVER LOGS and the operator CLI, never a rendered
  // page — the route turns a generic throw into a 500 with a generic body — so
  // it uses the PLAIN-SPACE formatter from lib/utils, not the non-breaking-space
  // UI one. An NBSP in a log line or a terminal is a grep and copy-paste hazard.
  it("renders a large mismatch with a thousands separator and a plain space", async () => {
    const tx = makeTx({ id: "evt-1", commissionCents: 105_000 })
    const bigPlan = { ...planned, principalCents: 10_500_000, commissionCents: 210_000 }

    await expect(applyBackfillAccrual(tx as never, bigPlan, "ops@example.invalid", vi.fn()))
      .rejects.toThrow("R 1,050.00")
  })

  it("records the full accrual context in the audit row", async () => {
    const tx = makeTx({ id: "evt-1", commissionCents: 1_000 })
    await applyBackfillAccrual(tx as never, planned, "ops@example.invalid", vi.fn())
    const written = tx.auditLog.create.mock.calls[0][0].data.newValue
    expect(written).toMatchObject({
      loanId: "L1",
      loanReference: "LN-0001",
      agentName: "Test Agent",
      principalCents: 100_000,
      bps: 100,
      commissionCents: 1_000,
      approvedBy: "ops@example.invalid",
    })
  })

  // The re-attribution path reverses the outgoing agent's row inside the same
  // transaction, so BOTH the accrual's idempotency check and this verification
  // read must ignore that REVERSED row — otherwise the verification finds the
  // reversed prior, compares its amount, and rolls back a correct write.
  it("passes the supersede flag through and verifies past the row it reversed", async () => {
    const tx = makeTx({ id: "evt-new", commissionCents: 1_000 })
    const record = vi.fn().mockResolvedValue(undefined)
    await applyBackfillAccrual(tx as never, planned, "admin@example.invalid", record, {
      supersedeReversedPriors: true,
      auditAction: "REFERRAL_COMMISSION_RETRO_ACCRUED",
      reason: "Referral agent re-attributed to Test Agent",
    })

    expect(record).toHaveBeenCalledWith(tx, {
      tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 100_000,
      supersedeReversedPriors: true,
    })
    expect(tx.referralEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ commissionStatus: { not: "REVERSED" } }),
    }))
  })

  // Distinct provenance: a rate-was-zero backfill and a manual re-attribution
  // are different acts and an auditor will ask which one wrote the row.
  it("stamps the caller's audit action and reason", async () => {
    const tx = makeTx({ id: "evt-new", commissionCents: 1_000 })
    await applyBackfillAccrual(tx as never, planned, "admin@example.invalid", vi.fn(), {
      auditAction: "REFERRAL_COMMISSION_RETRO_ACCRUED",
      reason: "Referral agent re-attributed to Test Agent",
    })

    const written = tx.auditLog.create.mock.calls[0][0].data
    expect(written.action).toBe("REFERRAL_COMMISSION_RETRO_ACCRUED")
    expect(written.newValue.reason).toBe("Referral agent re-attributed to Test Agent")
  })

  // NEW-1. The verification matched on loanId and amount ONLY. Two agents
  // sharing a bps produce the same commissionCents, so a row belonging to a
  // DIFFERENT agent satisfied the check — and this guard exists precisely to
  // refuse writing a figure the ledger does not contain. The `updatedAt` CAS on
  // the client edit cannot help: the disburse route accrues through
  // recordDisbursementCommission and never touches Client, so the CAS cannot
  // see it.
  it("scopes the verification to the agent the accrual was planned for", async () => {
    const tx = makeTx({ id: "evt-1", commissionCents: 1_000 })
    await applyBackfillAccrual(tx as never, planned, "ops@example.invalid", vi.fn())

    expect(tx.referralEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ agentId: "agent-1" }),
    }))
  })

  // Applies to BOTH callers: the same function verifies the operator-run
  // backfill and the manual re-attribution.
  it("refuses rather than verifying an accrual that names no agent", async () => {
    const tx = makeTx({ id: "evt-1", commissionCents: 1_000 })
    await expect(
      applyBackfillAccrual(tx as never, { ...planned, agentId: null }, "ops@example.invalid", vi.fn()),
    ).rejects.toThrow(/agent/i)
    expect(tx.auditLog.create).not.toHaveBeenCalled()
  })

  // Narrowing by agent still leaves a same-agent row that predates this write
  // able to satisfy the check. The caller already knows which rows existed, so
  // proving NEWNESS costs no extra query.
  it("excludes the rows the caller already knew about", async () => {
    const tx = makeTx({ id: "evt-new", commissionCents: 1_000 })
    await applyBackfillAccrual(tx as never, planned, "ops@example.invalid", vi.fn(), {
      knownPriorEventIds: ["evt-old-a", "evt-old-b"],
    })

    expect(tx.referralEvent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: { notIn: ["evt-old-a", "evt-old-b"] } }),
    }))
  })

  it("omits the exclusion entirely when the caller knew of no prior rows", async () => {
    const tx = makeTx({ id: "evt-new", commissionCents: 1_000 })
    await applyBackfillAccrual(tx as never, planned, "ops@example.invalid", vi.fn(), {
      knownPriorEventIds: [],
    })

    expect(tx.referralEvent.findFirst.mock.calls[0][0].where).not.toHaveProperty("id")
  })

  it("keeps the backfill defaults when no options are supplied", async () => {
    const tx = makeTx({ id: "evt-1", commissionCents: 1_000 })
    const record = vi.fn().mockResolvedValue(undefined)
    await applyBackfillAccrual(tx as never, planned, "ops@example.invalid", record)

    expect(record).toHaveBeenCalledWith(tx, {
      tenantId: "t1", loanId: "L1", clientId: "c1", principalCents: 100_000,
    })
    const where = tx.referralEvent.findFirst.mock.calls[0][0].where
    expect(where).not.toHaveProperty("commissionStatus")
    expect(tx.auditLog.create.mock.calls[0][0].data.action).toBe("REFERRAL_COMMISSION_BACKFILLED")
  })
})



describe("self-referral exclusion (Hein, 2026-08-06: agents do not earn on their own loan)", () => {
  it("skips a loan where the borrower is the agent", () => {
    const { accrue, skipped } = planCommissionBackfill(
      [candidate({ clientName: "AGENT ONE", agentName: "Agent One" })], 100)
    expect(accrue).toEqual([])
    expect(skipped[0]).toMatchObject({ reason: "SELF_REFERRAL" })
  })

  it("still accrues for a different borrower under the same agent", () => {
    const { accrue, skipped } = planCommissionBackfill(
      [candidate({ clientName: "Nhlanhla Given Mocktest", agentName: "Agent One" })], 100)
    expect(skipped).toEqual([])
    expect(accrue).toHaveLength(1)
  })

  // Name matching is a heuristic — two real people can share a name. The
  // exclusion must therefore be REPORTED, never silent, so a false positive is
  // visible to whoever signs off rather than quietly under-paying an agent.
  it("reports the exclusion rather than dropping it silently", () => {
    const { skipped } = planCommissionBackfill(
      [candidate({ loanReference: "LN-SELF", clientName: "A B", agentName: "a  b" })], 100)
    expect(skipped).toHaveLength(1)
    expect(skipped[0].loanReference).toBe("LN-SELF")
  })

  // Reported ahead of a zero rate: "the agent is the borrower" is the actionable
  // fact, and it stays true whatever the rate happens to be.
  it("reports SELF_REFERRAL in preference to ZERO_RATE", () => {
    const { skipped } = planCommissionBackfill(
      [candidate({ clientName: "A B", agentName: "A B" })], 0)
    expect(skipped[0]).toMatchObject({ reason: "SELF_REFERRAL" })
  })
})

describe("self-referral matching beyond the name", () => {
  const c = (over: Record<string, unknown> = {}) => candidate({
    clientName: "Nhlanhla Mocktest", agentName: "Agent One",
    clientPhone: "0821234567", clientEmail: "n@example.invalid",
    agentPhone: null, agentEmail: null, ...over,
  })

  // A middle name, a married name or a spelling change defeats string equality.
  // Phone is the identifier an agent cannot casually vary.
  it("matches on phone even when the names differ", () => {
    const { accrue, skipped } = planCommissionBackfill(
      [c({ clientName: "Agent Middle One", agentPhone: "0821234567" })], 100)
    expect(accrue).toEqual([])
    expect(skipped[0]).toMatchObject({ reason: "SELF_REFERRAL" })
  })

  it("normalises SA phone formats (+27 / 0 / spaces)", () => {
    const { skipped } = planCommissionBackfill(
      [c({ clientName: "Someone Else", clientPhone: "+27 82 123 4567", agentPhone: "0821234567" })], 100)
    expect(skipped[0]).toMatchObject({ reason: "SELF_REFERRAL" })
  })

  it("matches on email even when the names differ", () => {
    const { skipped } = planCommissionBackfill(
      [c({ clientName: "Someone Else", agentEmail: "N@Example.Invalid" })], 100)
    expect(skipped[0]).toMatchObject({ reason: "SELF_REFERRAL" })
  })

  // An agent with no contact details on file must not match every client.
  it("does not match when the agent has no phone or email", () => {
    const { accrue, skipped } = planCommissionBackfill([c()], 100)
    expect(skipped).toEqual([])
    expect(accrue).toHaveLength(1)
  })

  it("does not match a different person", () => {
    const { accrue } = planCommissionBackfill(
      [c({ agentPhone: "0839999999", agentEmail: "other@example.invalid" })], 100)
    expect(accrue).toHaveLength(1)
  })
})

describe("skip-reason ordering reports the most durable blocker", () => {
  // Reactivating the agent will not make a self-referral payable, so reporting
  // AGENT_NOT_ACTIVE first sends an operator down a road that does not end in
  // payment.
  it("reports SELF_REFERRAL ahead of AGENT_NOT_ACTIVE", () => {
    const { skipped } = planCommissionBackfill(
      [candidate({ clientName: "A B", agentName: "A B", agentStatus: "SUSPENDED" })], 100)
    expect(skipped[0]).toMatchObject({ reason: "SELF_REFERRAL" })
  })

  it("reports SELF_REFERRAL ahead of CODE_NOT_ACTIVE", () => {
    const { skipped } = planCommissionBackfill(
      [candidate({ clientName: "A B", agentName: "A B", codeStatus: "RETIRED" })], 100)
    expect(skipped[0]).toMatchObject({ reason: "SELF_REFERRAL" })
  })

  // Loan status stays first: a defaulted loan is not payable to anyone.
  it("still reports INELIGIBLE_LOAN_STATUS ahead of SELF_REFERRAL", () => {
    const { skipped } = planCommissionBackfill(
      [candidate({ clientName: "A B", agentName: "A B", loanStatus: "DEFAULTED" })], 100)
    expect(skipped[0]).toMatchObject({ reason: "INELIGIBLE_LOAN_STATUS" })
  })
})
