/**
 * Real-Postgres proof of the collections engine end to end on the simulated
 * rail: mandate → batch → a PAID result books exactly one receipt (re-ingesting
 * it is a no-op, by the unique resultKey) → two consecutive NPFs suspend the
 * mandate → a third presentment is refused by the database CHECK, and any
 * instruction on the suspended mandate by the trigger.
 *
 * GATED: RUN_COLLECTIONS_ENGINE_IT=1 and a DATABASE_URL to a throwaway,
 * migrated Postgres (scripts/run-integration-tests.sh). Time is moved with
 * fake Date only; the database clock is not involved in any rule here.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { createDebitMandate } from "./mandates"
import { runCollectionsCron, type TenantCollectionsRun } from "./cron"
import { loadEngineContext } from "./context"
import { recordOutcome, type IngestSummary } from "./results"
import { createFixture, INSTALMENT_1, INSTALMENT_2, type Fixture } from "./collections-engine.integration-fixture"
import type { CollectionOutcome } from "@/lib/integrations/collections/types"

const RUN = process.env.RUN_COLLECTIONS_ENGINE_IT === "1"
const suite = RUN ? describe : describe.skip

suite("collections engine on the simulated rail (real Postgres)", () => {
  let fx: Fixture
  let mandateId: string
  let firstPaid: CollectionOutcome

  const at = (iso: string) => vi.setSystemTime(new Date(iso))
  const cron = async (kind: "SUBMIT" | "RESULTS"): Promise<TenantCollectionsRun> => {
    const run = await runCollectionsCron(kind, new Date())
    const mine = run.perTenant.find((t) => t.tenantId === fx.tenantId)
    expect(mine?.outcome, JSON.stringify(mine)).toBe(kind)
    return mine!
  }
  const instructions = () => prisma.collectionInstruction.findMany({
    where: { tenantId: fx.tenantId }, orderBy: [{ actionDate: "asc" }, { presentmentNo: "asc" }],
  })
  const payments = () => prisma.payment.findMany({ where: { tenantId: fx.tenantId, loanId: fx.loanId } })
  const mandate = () => prisma.debitMandate.findFirstOrThrow({ where: { id: mandateId, tenantId: fx.tenantId } })
  const rawInsert = (presentmentNo: number, scheduleId: string) => prisma.$executeRawUnsafe(
    `INSERT INTO "CollectionInstruction" (id, "tenantId", "mandateId", "loanId", "repaymentScheduleId", "installmentNo",
       "presentmentNo", "amountCents", "actionDate", "trackingDays", "instructionRef", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 2, $6, 1000, '2027-01-25', 3, $1, now())`,
    `ci_raw_${presentmentNo}_${Date.now()}`, fx.tenantId, mandateId, fx.loanId, scheduleId, presentmentNo,
  )

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    at("2026-10-20T06:00:00Z")
    fx = await createFixture()
  })
  afterAll(async () => {
    vi.useRealTimers()
    await prisma.$disconnect()
  })

  it("creates a mandate and sends it for authorisation, then activates it when the debtor authorises", async () => {
    const created = await createDebitMandate(fx.tenantId, { userId: fx.userId, userEmail: "ce-admin@test.invalid" }, {
      loanId: fx.loanId, authType: "TT1", debitDay: 25, trackingDays: 3,
    }, new Date())
    mandateId = created.id
    expect(created).toMatchObject({ status: "PENDING_AUTH", simulated: true, amountCents: INSTALMENT_2, maxAmountCents: INSTALMENT_2 })
    expect(created.providerMandateRef).toMatch(/^SIM-A-/)

    const submit = await cron("SUBMIT")
    expect(submit).toMatchObject({ mandates: { changed: 1 }, planned: { planned: 1 }, submitted: { batches: 0 } })
    expect((await mandate()).status).toBe("ACTIVE")
    expect((await instructions()).map((i) => [i.installmentNo, i.presentmentNo, i.status, i.actionDate.toISOString().slice(0, 10)]))
      .toEqual([[1, 1, "PENDING", "2026-10-26"]])
  })

  it("submits the instruction in a batch two business days before its action date", async () => {
    at("2026-10-22T06:00:00Z")
    expect(await cron("SUBMIT")).toMatchObject({ submitted: { batches: 1, submitted: 1, rejected: 0 } })
    const batch = await prisma.collectionBatch.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    expect(batch).toMatchObject({ status: "SUBMITTED", instructionCount: 1, totalCents: INSTALMENT_1, simulated: true })
    expect((await instructions())[0].status).toBe("SUBMITTED")
  })

  it("books a PAID result as one receipt through the payment path", async () => {
    at("2026-10-27T06:00:00Z")
    expect(await cron("RESULTS")).toMatchObject({ results: { recorded: 1, allocated: 1, needsReview: 0 } })
    const [payment] = await payments()
    expect(payment).toMatchObject({ amount: INSTALMENT_1, paymentMethod: "DEBIT_ORDER", allocationStatus: "ALLOCATED" })
    const result = await prisma.collectionResult.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    expect(result).toMatchObject({ outcome: "PAID", paymentId: payment.id, simulated: true })
    const row1 = await prisma.repaymentSchedule.findFirstOrThrow({ where: { id: fx.rows[0].id, tenantId: fx.tenantId } })
    expect(row1.status).toBe("PAID")
    firstPaid = {
      instructionRef: (await instructions())[0].instructionRef, status: "PAID", reason: null, rawCode: "SIM-PAID",
      settledAmountCents: INSTALMENT_1, resolvedAt: result.resolvedAt, simulated: true,
    }
  })

  it("treats the same result reported again as a no-op: still one result, one receipt", async () => {
    const ctx = (await loadEngineContext(fx.tenantId, new Date()))!
    const summary = { recorded: 0, duplicates: 0, allocated: 0, needsReview: 0, suspended: 0, unmatched: 0, fetched: 0, errors: [] } as IngestSummary
    await recordOutcome(ctx, firstPaid, summary)
    await recordOutcome(ctx, { ...firstPaid }, summary)
    expect(summary).toMatchObject({ recorded: 0, duplicates: 2, allocated: 0 })
    expect(await prisma.collectionResult.count({ where: { tenantId: fx.tenantId } })).toBe(1)
    expect(await payments()).toHaveLength(1)
  })

  it("re-presents an NPF once and suspends the mandate after the second consecutive NPF", async () => {
    at("2026-11-23T06:00:00Z")
    expect(await cron("SUBMIT")).toMatchObject({ planned: { planned: 1 }, submitted: { submitted: 1 } })
    at("2026-11-26T06:00:00Z")
    expect(await cron("RESULTS")).toMatchObject({ results: { recorded: 1, suspended: 0 } })
    expect((await mandate()).status).toBe("ACTIVE")

    at("2026-12-20T06:00:00Z")
    expect(await cron("SUBMIT")).toMatchObject({ planned: { planned: 1 } })
    at("2026-12-23T06:00:00Z")
    expect(await cron("SUBMIT")).toMatchObject({ submitted: { submitted: 1 } })
    at("2026-12-29T06:00:00Z")
    expect(await cron("RESULTS")).toMatchObject({ results: { recorded: 1, suspended: 1 } })

    expect((await instructions()).map((i) => [i.installmentNo, i.presentmentNo, i.status, i.actionDate.toISOString().slice(0, 10)])).toEqual([
      [1, 1, "PAID", "2026-10-26"],
      [2, 1, "UNPAID", "2026-11-25"],
      [2, 2, "UNPAID", "2026-12-28"],
    ])
    const m = await mandate()
    expect(m.status).toBe("SUSPENDED")
    expect(m.statusReason).toMatch(/2 consecutive/)
    expect(await prisma.loanNote.count({ where: { tenantId: fx.tenantId, loanId: fx.loanId, type: "debit_order_unpaid" } })).toBe(2)
    expect(await payments()).toHaveLength(1)
    expect(INSTALMENT_2 % 100).toBe(1)
  })

  it("plans nothing more on the suspended mandate", async () => {
    at("2027-01-20T06:00:00Z")
    expect(await cron("SUBMIT")).toMatchObject({ planned: { mandates: 0, planned: 0 } })
  })

  it("refuses a third presentment of the instalment in the database, by the presentment-cap CHECK", async () => {
    await expect(rawInsert(3, fx.rows[1].id)).rejects.toThrow(/CollectionInstruction_presentment_cap/)
  })

  it("refuses any instruction on a mandate that is not ACTIVE, by the trigger", async () => {
    await expect(rawInsert(2, fx.rows[0].id)).rejects.toThrow(/is SUSPENDED, not ACTIVE/)
  })

  it("never re-activates a suspended mandate, by the status trigger", async () => {
    await expect(prisma.$executeRawUnsafe(`UPDATE "DebitMandate" SET status = 'ACTIVE' WHERE id = $1`, mandateId))
      .rejects.toThrow(/cannot move from SUSPENDED to ACTIVE/)
  })

  it("audited every step", async () => {
    const actions = await prisma.auditLog.groupBy({
      by: ["action"], where: { tenantId: fx.tenantId, action: { startsWith: "COLLECTION_" } }, _count: true,
    })
    const counts = Object.fromEntries(actions.map((a) => [a.action, a._count]))
    expect(counts).toMatchObject({
      COLLECTION_MANDATE_CREATED: 1, COLLECTION_INSTRUCTION_PLANNED: 3, COLLECTION_BATCH_SUBMITTED: 3, COLLECTION_RESULT_RECORDED: 3,
    })
    expect(counts.COLLECTION_MANDATE_STATUS_CHANGED).toBe(3)
  })
})
