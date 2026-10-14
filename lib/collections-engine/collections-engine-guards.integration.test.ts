/**
 * Real-Postgres proof of the engine's guards against stale or half-written state:
 * - H4 (breaker REPRO 1): a loan written off after planning is not debited; its
 *   mandate is cancelled here and at the provider.
 * - H5 (breaker REPRO 2): stop rules a crashed run never applied are applied
 *   on the next run, by the results run and by the planner.
 * - T2: a PAID result recorded but never booked is booked exactly once.
 * - T3: DISPUTED notes, reviews and suspends; after a payment it never moves it.
 * - T4: submission cancels stale, settled and non-ACTIVE-mandate instructions
 *   and clamps the amount to what is outstanding.
 * - M8: a settled amount that differs is not booked; a debit landing on an
 *   instalment already paid is booked and reviewed.
 *
 * GATED: RUN_COLLECTIONS_ENGINE_IT=1, DATABASE_URL to a throwaway migrated Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import { emptyIngest, recordOutcome } from "./results"
import { submitDueInstructions } from "./submit"
import { activeMandate, at, createFixture, ctxOf, inTenant, insertInstruction, instructionsOf, paymentsOf, resetFlaky, run, type Fixture } from "./collections-engine.it-helpers"

const RUN = process.env.RUN_COLLECTIONS_ENGINE_IT === "1"
const suite = RUN ? describe : describe.skip

suite("collections engine guards (real Postgres)", () => {
  let fx: Fixture
  let mandateId: string
  const mandate = () => prisma.debitMandate.findFirstOrThrow({ where: { id: mandateId, tenantId: fx.tenantId } })
  const npfResult = (instructionId: string, resolvedAt: string) => prisma.collectionResult.create({
    data: {
      tenantId: fx.tenantId, provider: "simulated", instructionId, resultKey: `${instructionId}:UNPAID`, outcome: "UNPAID",
      reasonCode: "INSUFFICIENT_FUNDS", rawPayload: {}, resolvedAt: new Date(resolvedAt), processedAt: new Date(resolvedAt),
    },
  })
  const outcome = (instructionRef: string, status: "PAID" | "DISPUTED", settled: number | null) => ({
    instructionRef, status, reason: status === "DISPUTED" ? "PAYMENT_STOPPED" as const : null, rawCode: "IT",
    settledAmountCents: settled, resolvedAt: new Date("2026-10-26T00:00:00Z"),
  })

  beforeAll(() => vi.useFakeTimers({ toFake: ["Date"] }))
  afterAll(async () => {
    vi.useRealTimers()
    await prisma.$disconnect()
  })
  beforeEach(async () => {
    resetFlaky()
    at("2026-10-15T06:00:00Z")
    fx = await createFixture({ instalments: [100_000, 100_000, 100_000, 100_000] })
    mandateId = await activeMandate(fx)
  })

  it("H4: a loan written off after planning is not debited, and its mandate is withdrawn here and at the provider", async () => {
    expect(await run(fx, "SUBMIT")).toMatchObject({ planned: { planned: 1 }, submitted: { batches: 0 } })
    await prisma.loan.update({ where: { id: fx.loanId, tenantId: fx.tenantId }, data: { status: "WRITTEN_OFF" } })
    at("2026-10-20T06:00:00Z")
    expect(await run(fx, "SUBMIT")).toMatchObject({ sweeps: { closed: 1, providerCancelled: 1 }, submitted: { batches: 0 } })
    expect((await instructionsOf(fx))[0]).toMatchObject({ status: "CANCELLED", statusReason: expect.stringMatching(/Loan is WRITTEN_OFF/) })
    expect(await mandate()).toMatchObject({ status: "CANCELLED", providerCancelledAt: expect.any(Date) })
    expect(await prisma.collectionBatch.count({ where: { tenantId: fx.tenantId } })).toBe(0)
  })

  it("H4: submission itself refuses an instruction whose loan is no longer collectible", async () => {
    await insertInstruction(fx, mandateId, { row: 1, actionDate: "2026-10-26", amountCents: 100_000 })
    await prisma.loan.update({ where: { id: fx.loanId, tenantId: fx.tenantId }, data: { status: "COMPLETED" } })
    at("2026-10-20T06:00:00Z")
    const summary = await inTenant(fx, async () => submitDueInstructions(await ctxOf(fx)))
    expect(summary).toMatchObject({ notCollectible: 1, batches: 0 })
    expect((await instructionsOf(fx))[0]).toMatchObject({ status: "CANCELLED", statusReason: "Loan is COMPLETED" })
  })

  it("H5: two NPFs a crashed run recorded without suspending are acted on by the next results run", async () => {
    const a = await insertInstruction(fx, mandateId, { row: 1, presentmentNo: 1, status: "UNPAID", actionDate: "2026-09-25", amountCents: 100_000 })
    const b = await insertInstruction(fx, mandateId, { row: 1, presentmentNo: 2, status: "UNPAID", actionDate: "2026-10-26", amountCents: 100_000 })
    await npfResult(a.id, "2026-09-25T00:00:00Z")
    await npfResult(b.id, "2026-10-26T00:00:00Z")
    expect((await mandate()).status).toBe("ACTIVE")
    expect(await run(fx, "RESULTS")).toMatchObject({ results: { suspended: 1 } })
    expect((await mandate()).status).toBe("SUSPENDED")
  })

  it("H5: the planner applies them too, and plans nothing on that mandate", async () => {
    const a = await insertInstruction(fx, mandateId, { row: 1, presentmentNo: 1, status: "UNPAID", actionDate: "2026-09-25", amountCents: 100_000 })
    const b = await insertInstruction(fx, mandateId, { row: 1, presentmentNo: 2, status: "UNPAID", actionDate: "2026-10-26", amountCents: 100_000 })
    await npfResult(a.id, "2026-09-25T00:00:00Z")
    await npfResult(b.id, "2026-10-26T00:00:00Z")
    expect(await run(fx, "SUBMIT")).toMatchObject({ planned: { suspended: 1, planned: 0 } })
    expect((await mandate()).status).toBe("SUSPENDED")
  })

  it("T2: a PAID result recorded but never booked is booked by the next run, exactly once", async () => {
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "PAID", actionDate: "2026-10-14", amountCents: 100_000 })
    const r = await prisma.collectionResult.create({
      data: {
        tenantId: fx.tenantId, provider: "simulated", instructionId: i.id, resultKey: `${i.instructionRef}:PAID`, outcome: "PAID",
        settledAmountCents: 100_000, rawPayload: {}, resolvedAt: new Date("2026-10-14T00:00:00Z"),
      },
    })
    expect(await run(fx, "RESULTS")).toMatchObject({ results: { allocated: 1 } })
    await run(fx, "RESULTS")
    const payments = await paymentsOf(fx)
    expect(payments).toHaveLength(1)
    expect(payments[0]).toMatchObject({ idempotencyKey: `collection-result:${r.id}`, amount: 100_000 })
  })

  it("T3: a DISPUTED result notes the loan, asks for review and suspends the mandate", async () => {
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-14", amountCents: 100_000 })
    await inTenant(fx, async () => recordOutcome(await ctxOf(fx), outcome(i.instructionRef, "DISPUTED", null), emptyIngest()))
    expect((await instructionsOf(fx))[0].status).toBe("DISPUTED")
    expect(await prisma.loanNote.findFirst({ where: { tenantId: fx.tenantId, type: "debit_order_unpaid" } }))
      .toMatchObject({ note: expect.stringMatching(/disputed/) })
    expect(await prisma.collectionResult.findFirst({ where: { tenantId: fx.tenantId } })).toMatchObject({ reviewReason: expect.stringMatching(/disputed/) })
    expect((await mandate()).status).toBe("SUSPENDED")
  })

  it("T3/H1: a dispute after the debit was paid keeps it PAID, is reviewed, and still suspends the mandate", async () => {
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "PAID", actionDate: "2026-10-14", amountCents: 100_000 })
    await inTenant(fx, async () => recordOutcome(await ctxOf(fx), outcome(i.instructionRef, "DISPUTED", null), emptyIngest()))
    expect((await instructionsOf(fx))[0].status).toBe("PAID")
    expect(await prisma.collectionResult.findFirst({ where: { tenantId: fx.tenantId } })).toMatchObject({ reportedAfterPayment: true })
    expect(await prisma.loanNote.count({ where: { tenantId: fx.tenantId, type: "debit_order_review" } })).toBe(1)
    expect((await mandate()).status).toBe("SUSPENDED")
  })

  it("T4: submission cancels stale and settled instructions and clamps the amount to what is outstanding", async () => {
    await insertInstruction(fx, mandateId, { row: 1, actionDate: "2026-10-19", amountCents: 100_000 })
    await insertInstruction(fx, mandateId, { row: 2, actionDate: "2026-10-26", amountCents: 50_000 })
    await insertInstruction(fx, mandateId, { row: 3, actionDate: "2026-10-26", amountCents: 100_000 })
    await prisma.repaymentSchedule.update({ where: { id: fx.rows[1].id, tenantId: fx.tenantId }, data: { totalPaid: 100_000, status: "PAID" } })
    await prisma.repaymentSchedule.update({ where: { id: fx.rows[2].id, tenantId: fx.tenantId }, data: { totalPaid: 40_000, status: "PARTIAL" } })
    at("2026-10-20T06:00:00Z")
    const summary = await inTenant(fx, async () => submitDueInstructions(await ctxOf(fx)))
    expect(summary).toMatchObject({ stale: 1, settled: 1, batches: 1, uploaded: 1 })
    expect((await instructionsOf(fx)).map((i) => [i.installmentNo, i.status, i.amountCents, i.statusReason])).toEqual([
      [1, "CANCELLED", 100_000, "Action date passed before submission"],
      [2, "CANCELLED", 50_000, "Instalment settled before submission"],
      [3, "UPLOADED", 60_000, null],
    ])
  })

  it("T4: submission cancels an instruction whose mandate is no longer ACTIVE", async () => {
    await insertInstruction(fx, mandateId, { row: 1, actionDate: "2026-10-26", amountCents: 100_000 })
    await prisma.$executeRawUnsafe(`UPDATE "DebitMandate" SET status = 'SUSPENDED' WHERE id = $1`, mandateId)
    at("2026-10-20T06:00:00Z")
    expect(await inTenant(fx, async () => submitDueInstructions(await ctxOf(fx)))).toMatchObject({ batches: 0 })
    expect((await instructionsOf(fx))[0]).toMatchObject({ status: "CANCELLED", statusReason: "Mandate is SUSPENDED" })
  })

  it("M8: a settled amount that differs from the debit is not booked and asks for review", async () => {
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-14", amountCents: 100_000 })
    await inTenant(fx, async () => recordOutcome(await ctxOf(fx), outcome(i.instructionRef, "PAID", 90_000), emptyIngest()))
    expect(await paymentsOf(fx)).toHaveLength(0)
    expect(await prisma.collectionResult.findFirst({ where: { tenantId: fx.tenantId } }))
      .toMatchObject({ paymentId: null, processedAt: expect.any(Date), reviewReason: expect.stringMatching(/not booked/) })
  })

  it("M8: a debit settling on an instalment already paid by hand is booked (the money is real) and reviewed", async () => {
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-14", amountCents: 100_000 })
    await inTenant(fx, () => applyManualReceipt(prisma, { loanId: fx.loanId, tenantId: fx.tenantId, amount: 100_000, capturedById: fx.userId }))
    await inTenant(fx, async () => recordOutcome(await ctxOf(fx), outcome(i.instructionRef, "PAID", 100_000), emptyIngest()))
    expect(await paymentsOf(fx)).toHaveLength(2)
    expect(await prisma.collectionResult.findFirst({ where: { tenantId: fx.tenantId } }))
      .toMatchObject({ paymentId: expect.any(String), reviewReason: expect.stringMatching(/refund/) })
  })
})
