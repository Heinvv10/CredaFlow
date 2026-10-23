/**
 * Real-Postgres proof that the nightly outcome job does not re-derive a
 * finalised loan (credaflow-adapter.ts, finalized.ts): a settled loan whose
 * every row is final, carries the current OUTCOME_DEFINITION_VERSION and has
 * no new returned debit order is left as it was, and is derived again the
 * moment any of those stops holding. A row is tampered with to tell "left
 * alone" from "derived to the same value". Every person, lender and amount is
 * synthetic.
 *
 *   RUN_DECISION_OUTCOMES_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/learning-loop/outcomes/skip.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { recordDecisions, type DecisionLogDb } from "../decision-log"
import { consumerApprovalRecords } from "../records"
import { credaflowOutcomeAdapter, type CredaflowOutcomeDb } from "./credaflow-adapter"
import { OUTCOME_DEFINITION_VERSION } from "./definition"
import { runTenantDecisionOutcomes, type OutcomeJobDb } from "./job"

const suite = process.env.RUN_DECISION_OUTCOMES_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
// Every window (12M from the 1 Sep 2026 due day) has ended.
const ASOF = new Date("2028-01-01T10:00:00+02:00")

let tenantId = ""
let loanId = ""
let approvalId = ""

/** The job's database, counting what the adapter reads from each table. */
function counting() {
  const reads: Record<string, number> = {}
  const snapshotWhere: unknown[] = []
  const proxy = new Proxy(db, {
    get(target, prop, receiver) {
      const model = Reflect.get(target, prop, receiver) as Record<string, unknown>
      if (typeof prop !== "string" || model === null || typeof model !== "object" || typeof model.findMany !== "function") return model
      return new Proxy(model, {
        get(m, op) {
          const fn = m[op as string]
          if (typeof fn !== "function") return fn
          return (...args: unknown[]) => {
            reads[`${prop}.${String(op)}`] = (reads[`${prop}.${String(op)}`] ?? 0) + 1
            if (prop === "loanArrearsSnapshot" && op === "findMany") snapshotWhere.push((args[0] as { where: unknown }).where)
            return (fn as (...a: unknown[]) => unknown).apply(m, args)
          }
        },
      })
    },
  })
  return { reads, snapshotWhere, db: proxy as unknown as CredaflowOutcomeDb & OutcomeJobDb }
}

async function run() {
  const c = counting()
  const [result] = await runTenantDecisionOutcomes(tenantId, ASOF, [credaflowOutcomeAdapter(c.db)], c.db)
  return { result, snapshotReads: c.reads["loanArrearsSnapshot.findMany"] ?? 0, snapshotWhere: c.snapshotWhere }
}

const approvalRows = () => db.decisionOutcome.findMany({ where: { tenantId, decisionRecordId: approvalId }, orderBy: { id: "asc" } })
const paidRow = async () => db.decisionOutcome.findFirstOrThrow({ where: { decisionRecordId: approvalId, outcomeKind: "PAID", window: "INSTALMENT:1" } })

/** An UNPAID presentment result for the loan's only instalment. */
async function returnedDebitOrder(userId: string, clientId: string) {
  const schedule = await db.repaymentSchedule.findFirstOrThrow({ where: { loanId }, select: { id: true } })
  const mandate = await db.debitMandate.create({ data: {
    tenantId, loanId, clientId, provider: "simulated", authType: "TT1", amountCents: 216_900, maxAmountCents: 216_900,
    debitDay: 1, frequency: "MONTHLY", trackingDays: 3, firstCollectionDate: new Date("2026-09-01"),
    accountHolder: "Synthetic Holder", bankName: "Synthetic Bank", branchCode: "000000", accountNumber: "0000000000", accountType: "CURRENT",
    simulated: true, createdById: userId,
  } })
  for (const status of ["SUBMITTING", "ACTIVE"] as const) await db.debitMandate.update({ where: { id: mandate.id }, data: { status } })
  const instruction = await db.collectionInstruction.create({ data: {
    tenantId, mandateId: mandate.id, loanId, repaymentScheduleId: schedule.id, installmentNo: 1, presentmentNo: 1,
    amountCents: 216_900, actionDate: new Date("2026-09-01"), trackingDays: 3, instructionRef: `it-${randomUUID()}`, status: "UNPAID",
  } })
  await db.collectionResult.create({ data: {
    tenantId, provider: "simulated", instructionId: instruction.id, resultKey: `${instruction.id}:UNPAID`, outcome: "UNPAID",
    reasonCode: "INSUFFICIENT_FUNDS", rawPayload: {}, resolvedAt: new Date("2026-09-03T08:00:00Z"), simulated: false, reportedAfterPayment: false,
  } })
}

suite("outcome job skips a finalised loan (real Postgres)", () => {
  let userId = ""
  let clientId = ""

  beforeAll(async () => {
    const tenant = await createChargesTenant(db, false)
    const created = await createChargesLoan(db, tenant)
    ;({ tenantId, loanId, userId, clientId } = { tenantId: tenant.tenantId, loanId: created.loanId, userId: tenant.userId, clientId: created.clientId })
    const loan = await db.loan.findUniqueOrThrow({ where: { id: loanId }, select: { applicationId: true, createdAt: true } })
    await db.$transaction((tx) => recordDecisions(tx as unknown as DecisionLogDb, consumerApprovalRecords({
      tenantId, applicationId: loan.applicationId, clientId, actor: { userId, role: "LOAN_ADMIN" },
      decidedAt: new Date(loan.createdAt.getTime() - 60_000),
      productType: "MICRO", interestRatePm: 0.05, principalCents: 200_000, termDays: 31, instalmentCents: 216_900,
      creditLifePremiumCents: 0, repaymentMethod: "DEBIT_ORDER", monthlyIncomeCents: 2_000_000,
      thresholds: { bureauMinScore: 580, bureauBlockAdverse: false, ndiBufferPct: 110, bureauMaxAgeDays: 60 },
      bureau: { id: "bureau-it", provider: "experian", score: 640, unscoreable: false, hasAdverse: false, deceased: false, underDebtReview: false, hasJudgement: false, hasNotice: false, obligations: { totalMonthly: 0 } },
      bureauGateBlocked: false, bureauOverrideReason: null,
      affordability: { ndiCents: 600_000, requiredNdiCents: 300_000 }, screeningState: "CLEAR", creditCheckFlags: [],
      affordabilitySnapshot: { policyVersion: "approval-ndi-v3", inputFingerprint: "a".repeat(64), decisionFingerprint: "b".repeat(64) },
    })))
    approvalId = (await db.creditDecisionRecord.findFirstOrThrow({ where: { tenantId, kind: "CREDIT_DECISION" }, select: { id: true } })).id
    await db.loan.update({ where: { id: loanId }, data: { status: "COMPLETED", closedAt: new Date("2026-09-02T10:00:00+02:00") } })
  }, 60_000)

  afterAll(() => db.$disconnect())

  it("derives a settled loan once, with every row final", async () => {
    const first = await run()
    expect(first.snapshotReads).toBe(1)
    // The history is read from the loan's first due day (1 Sep 2026) to its 12M window end, not from the start of time.
    expect(first.snapshotWhere).toMatchObject([{ snapshotDate: { gte: new Date("2026-09-01T00:00:00.000Z"), lt: new Date("2027-09-01T00:00:00.000Z") } }])
    const rows = await approvalRows()
    expect(rows.length).toBeGreaterThan(0)
    expect(rows.some((r) => r.state === "PENDING")).toBe(false)
    expect(rows.every((r) => r.definitionVersion === OUTCOME_DEFINITION_VERSION)).toBe(true)
  })

  it("leaves it alone the next night: its snapshots are not read and its rows are not written", async () => {
    const before = await paidRow()
    // Tamper with a final row: a derive-to-the-same-value would put it back.
    await db.decisionOutcome.update({ where: { id: before.id }, data: { value: true, observedAt: before.observedAt } })
    const next = await run()
    expect(next.snapshotReads).toBe(0)
    expect(next.result.skippedLoans).toBe(1)
    expect((await paidRow()).value).toBe(true)
  })

  it("derives it again when its rows carry an older definition version", async () => {
    await db.decisionOutcome.updateMany({ where: { decisionRecordId: approvalId }, data: { definitionVersion: "outcomes-v1" } })
    const next = await run()
    expect(next.snapshotReads).toBe(1)
    expect(next.result.skippedLoans).toBe(0)
    expect((await paidRow()).value).toBe(false)
    expect((await approvalRows()).every((r) => r.definitionVersion === OUTCOME_DEFINITION_VERSION)).toBe(true)
  })

  it("derives it again while a row is still pending", async () => {
    await db.decisionOutcome.updateMany({
      where: { decisionRecordId: approvalId, outcomeKind: "EVER_30_DPD", window: "3M" }, data: { state: "PENDING", value: null, observedAt: null, reasonCode: null },
    })
    expect((await run()).snapshotReads).toBe(1)
    expect(await db.decisionOutcome.count({ where: { decisionRecordId: approvalId, state: "PENDING" } })).toBe(0)
  })

  it("derives it again when a returned debit order arrives for the finalised loan", async () => {
    expect((await run()).snapshotReads).toBe(0)
    await returnedDebitOrder(userId, clientId)
    const next = await run()
    expect(next.snapshotReads).toBe(1)
    expect(await db.decisionOutcome.count({ where: { decisionRecordId: approvalId, outcomeKind: "RETURNED_DEBIT_ORDER" } })).toBe(1)
    expect((await run()).snapshotReads).toBe(0)
  })

  it("never skips a loan that is still open", async () => {
    await db.loan.update({ where: { id: loanId }, data: { status: "ACTIVE", closedAt: null } })
    expect((await run()).snapshotReads).toBe(1)
  })
})
