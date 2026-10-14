/**
 * Real-Postgres proof of the collections engine end to end on the simulated
 * rail (asynchronous registration and load reports): mandate → batch → a PAID
 * result books exactly one receipt (re-ingesting it, also concurrently, is a
 * no-op) → an UNPAID reported after that payment never moves it and is not an
 * NPF (H1) → two consecutive NPFs suspend the mandate and withdraw it at the
 * provider (M2) → a third presentment is refused by the CHECK, and a fresh
 * mandate cannot present the instalment again (H6).
 *
 * GATED: RUN_COLLECTIONS_ENGINE_IT=1 and a DATABASE_URL to a throwaway,
 * migrated Postgres (scripts/run-integration-tests.sh). Time moves by fake
 * Date only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { simulatedCollections } from "@/lib/integrations/collections/simulated"
import type { CollectionOutcome } from "@/lib/integrations/collections/types"
import { createDebitMandate } from "./mandates"
import { emptyIngest, recordOutcome } from "./results"
import { at, createFixture, ctxOf, day, inTenant, instructionsOf, INSTALMENT_1, paymentsOf, run, type Fixture } from "./collections-engine.it-helpers"

const RUN = process.env.RUN_COLLECTIONS_ENGINE_IT === "1"
const suite = RUN ? describe : describe.skip

suite("collections engine on the simulated rail (real Postgres)", () => {
  let fx: Fixture
  let mandateId: string
  let firstPaid: CollectionOutcome

  const mandate = (id = mandateId) => prisma.debitMandate.findFirstOrThrow({ where: { id, tenantId: fx.tenantId } })
  const rawInsert = (presentmentNo: number, scheduleId: string, onMandate = mandateId) => prisma.$executeRawUnsafe(
    `INSERT INTO "CollectionInstruction" (id, "tenantId", "mandateId", "loanId", "repaymentScheduleId", "installmentNo",
       "presentmentNo", "amountCents", "actionDate", "trackingDays", "instructionRef", "updatedAt")
     VALUES ($1, $2, $3, $4, $5, 2, $6, 1000, '2027-01-25', 3, $1, now())`,
    `ci_raw_${presentmentNo}_${Math.random().toString(36).slice(2)}`, fx.tenantId, onMandate, fx.loanId, scheduleId, presentmentNo,
  )
  const create = () => inTenant(fx, () => createDebitMandate(fx.tenantId, { userId: fx.userId, userEmail: "ce-admin@test.invalid" }, {
    loanId: fx.loanId, authType: "TT1", debitDay: 25, trackingDays: 3,
  }, new Date()))

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ["Date"] })
    at("2026-10-20T06:00:00Z")
    fx = await createFixture()
  })
  afterAll(async () => {
    vi.useRealTimers()
    await prisma.$disconnect()
  })

  it("uploads the mandate for registration, then registers, authorises, plans, uploads and loads in one run", async () => {
    const created = await create()
    mandateId = created.id
    expect(created).toMatchObject({ status: "PENDING_REGISTRATION", providerMandateRef: null, simulated: true })

    const submit = await run(fx, "SUBMIT")
    expect(submit).toMatchObject({ planned: { planned: 1 }, submitted: { batches: 1, uploaded: 1 }, reconcile: { loaded: 1 } })
    const m = await mandate()
    expect(m.status).toBe("ACTIVE")
    expect(m.providerMandateRef).toMatch(/^SIM-A-/)
    const [i] = await instructionsOf(fx)
    expect([i.installmentNo, i.presentmentNo, i.status, day(i.actionDate)]).toEqual([1, 1, "SUBMITTED", "2026-10-26"])
    const batch = await prisma.collectionBatch.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    expect(batch).toMatchObject({ status: "SUBMITTED", instructionCount: 1, acceptedCount: 1, totalCents: INSTALMENT_1, simulated: true })
  })

  it("books a PAID result as one receipt through the payment path", async () => {
    at("2026-10-27T06:00:00Z")
    expect(await run(fx, "RESULTS")).toMatchObject({ results: { recorded: 1, allocated: 1, needsReview: 0, errors: [] } })
    const [payment] = await paymentsOf(fx)
    expect(payment).toMatchObject({ amount: INSTALMENT_1, paymentMethod: "DEBIT_ORDER", allocationStatus: "ALLOCATED" })
    const result = await prisma.collectionResult.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    expect(result).toMatchObject({ outcome: "PAID", paymentId: payment.id, simulated: true, reviewReason: null })
    firstPaid = {
      instructionRef: (await instructionsOf(fx))[0].instructionRef, status: "PAID", reason: null, rawCode: "SIM-PAID",
      settledAmountCents: INSTALMENT_1, resolvedAt: result.resolvedAt, simulated: true,
    }
  })

  it("treats the same result reported again, in sequence or concurrently, as a no-op", async () => {
    const ctx = await ctxOf(fx)
    const summary = emptyIngest()
    await inTenant(fx, () => recordOutcome(ctx, firstPaid, summary))
    await inTenant(fx, () => Promise.all([recordOutcome(ctx, { ...firstPaid }, summary), recordOutcome(ctx, { ...firstPaid }, summary)]))
    expect(summary).toMatchObject({ recorded: 0, duplicates: 3, allocated: 0 })
    expect(await prisma.collectionResult.count({ where: { tenantId: fx.tenantId } })).toBe(1)
    expect(await paymentsOf(fx)).toHaveLength(1)
  })

  it("H1: an UNPAID reported after the debit was booked as paid never moves it, is reviewed, and is not an NPF", async () => {
    const ctx = await ctxOf(fx)
    await inTenant(fx, () => recordOutcome(ctx, {
      ...firstPaid, status: "UNPAID", reason: "INSUFFICIENT_FUNDS", rawCode: "LATE-RETURN", settledAmountCents: null,
      resolvedAt: new Date("2026-10-28T00:00:00Z"),
    }, emptyIngest()))
    const [i] = await instructionsOf(fx)
    expect(i.status).toBe("PAID")
    const late = await prisma.collectionResult.findFirstOrThrow({ where: { tenantId: fx.tenantId, outcome: "UNPAID" } })
    expect(late).toMatchObject({ reportedAfterPayment: true, reviewReason: expect.stringMatching(/after the debit was booked as paid/) })
    expect(await prisma.loanNote.count({ where: { tenantId: fx.tenantId, type: "debit_order_unpaid" } })).toBe(0)
    expect(await prisma.loanNote.count({ where: { tenantId: fx.tenantId, type: "debit_order_review" } })).toBe(1)
    expect((await mandate()).status).toBe("ACTIVE")
    expect(await paymentsOf(fx)).toHaveLength(1)
  })

  it("does not count that late return toward the NPF streak: one real NPF leaves the mandate ACTIVE", async () => {
    at("2026-11-20T06:00:00Z")
    expect(await run(fx, "SUBMIT")).toMatchObject({ planned: { planned: 1 }, submitted: { uploaded: 1 } })
    at("2026-11-26T06:00:00Z")
    expect(await run(fx, "RESULTS")).toMatchObject({ results: { recorded: 1, suspended: 0, errors: [] } })
    expect((await mandate()).status).toBe("ACTIVE")
  })

  it("re-presents the NPF once, suspends after the second, and withdraws the mandate at the provider", async () => {
    at("2026-12-20T06:00:00Z")
    expect(await run(fx, "SUBMIT")).toMatchObject({ planned: { planned: 1 }, submitted: { uploaded: 1 } })
    at("2026-12-29T06:00:00Z")
    expect(await run(fx, "RESULTS")).toMatchObject({ results: { recorded: 1, suspended: 1 }, sweeps: { providerCancelled: 1 } })
    expect((await instructionsOf(fx)).map((i) => [i.installmentNo, i.presentmentNo, i.status, day(i.actionDate)])).toEqual([
      [1, 1, "PAID", "2026-10-26"],
      [2, 1, "UNPAID", "2026-11-25"],
      [2, 2, "UNPAID", "2026-12-28"],
    ])
    const m = await mandate()
    expect(m).toMatchObject({ status: "SUSPENDED", statusReason: expect.stringMatching(/2 consecutive/) })
    expect(m.providerCancelledAt).not.toBeNull()
    expect(await simulatedCollections.getMandateStatus(m.providerMandateRef!, {})).toBe("CANCELLED")
    expect(await prisma.loanNote.count({ where: { tenantId: fx.tenantId, type: "debit_order_unpaid" } })).toBe(2)
    expect(await paymentsOf(fx)).toHaveLength(1)
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

  it("H6: a fresh mandate cannot present the exhausted instalment again, in the planner or the database", async () => {
    at("2027-01-05T06:00:00Z")
    const fresh = await create()
    // First collection 25 Jan: inside the planning horizon from the 15th, so
    // the planner would present the instalment if it counted per mandate.
    expect(day(fresh.firstCollectionDate)).toBe("2027-01-25")
    at("2027-01-15T06:00:00Z")
    const submit = await run(fx, "SUBMIT")
    expect((await mandate(fresh.id)).status).toBe("ACTIVE")
    // skipped 0: the planner itself does not try; the database unique is the second line, tested below.
    expect(submit).toMatchObject({ planned: { mandates: 1, planned: 0, skipped: 0, errors: [] } })
    // The per-instalment unique (CollectionInstruction_presentment_once): no mandateId in its key.
    await expect(rawInsert(1, fx.rows[1].id, fresh.id)).rejects.toThrow(/Key \("repaymentScheduleId", "presentmentNo"\)=/)
  })
})
