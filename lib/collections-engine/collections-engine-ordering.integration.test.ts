/**
 * Real-Postgres proof for the round-2 ordering findings:
 * - N2: a return reported with (or before) the payment it reverses can never
 *   leave a silent receipt — outcomes are applied in resolvedAt order, and a
 *   PAID older than a recorded return is not booked.
 * - L1: replaying an unbooked PAID result after a crash does not mistake our
 *   own receipt for an earlier payment, and dates the receipt the same way.
 *
 * GATED: RUN_COLLECTIONS_ENGINE_IT=1, DATABASE_URL to a throwaway migrated Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import type { CollectionOutcome } from "@/lib/integrations/collections/types"
import { emptyIngest, recordOutcome } from "./results"
import { activeMandate, at, createFixture, ctxOf, flaky, inTenant, insertInstruction, instructionsOf, paymentsOf, resetFlaky, run, type Fixture } from "./collections-engine.it-helpers"

const RUN = process.env.RUN_COLLECTIONS_ENGINE_IT === "1"
const suite = RUN ? describe : describe.skip

suite("collections engine: outcome ordering and replay (real Postgres)", () => {
  let fx: Fixture
  let ref: string
  let instructionId: string
  const paid = (resolved: string): CollectionOutcome => ({ instructionRef: ref, status: "PAID", reason: null, rawCode: "OK", settledAmountCents: 100_000, resolvedAt: new Date(resolved) })
  const returned = (resolved: string): CollectionOutcome => ({ instructionRef: ref, status: "UNPAID", reason: "INSUFFICIENT_FUNDS", rawCode: "R", settledAmountCents: null, resolvedAt: new Date(resolved) })
  const results = () => prisma.collectionResult.findMany({ where: { tenantId: fx.tenantId }, orderBy: { resolvedAt: "asc" } })

  beforeAll(() => vi.useFakeTimers({ toFake: ["Date"] }))
  afterAll(async () => {
    vi.useRealTimers()
    await prisma.$disconnect()
  })
  beforeEach(async () => {
    resetFlaky()
    at("2026-10-20T06:00:00Z")
    fx = await createFixture({ provider: "it-flaky" })
    const mandateId = await activeMandate(fx)
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-26", amountCents: 100_000 })
    await prisma.collectionInstruction.update({ where: { id: i.id, tenantId: fx.tenantId }, data: { submittedAt: new Date("2026-10-20T06:00:00Z") } })
    ref = i.instructionRef
    instructionId = i.id
    at("2026-10-29T06:00:00Z")
  })

  it("N2: a payment and its later return in one fetch, listed return-first, book the receipt and flag the return", async () => {
    flaky.outcomes = [returned("2026-10-28T00:00:00Z"), paid("2026-10-26T00:00:00Z")]
    await run(fx, "RESULTS")
    expect((await instructionsOf(fx))[0].status).toBe("PAID")
    expect(await paymentsOf(fx)).toHaveLength(1)
    const [p, r] = await results()
    expect(p).toMatchObject({ outcome: "PAID", reportedAfterPayment: false })
    expect(r).toMatchObject({ outcome: "UNPAID", reportedAfterPayment: true, reviewReason: expect.any(String) })
    expect(await prisma.loanNote.count({ where: { tenantId: fx.tenantId, type: "debit_order_unpaid" } })).toBe(0)
  })

  it("N2: a payment reported after a later-dated return is not booked silently", async () => {
    flaky.outcomes = [returned("2026-10-28T00:00:00Z")]
    await run(fx, "RESULTS")
    flaky.outcomes = [paid("2026-10-26T00:00:00Z")]
    at("2026-10-30T06:00:00Z")
    await run(fx, "RESULTS")
    expect(await paymentsOf(fx)).toHaveLength(0)
    const paidResult = (await results()).find((x) => x.outcome === "PAID")
    expect(paidResult).toMatchObject({ paymentId: null, reviewReason: expect.stringMatching(/return/i) })
  })

  it("N2: a payment and a later return recorded concurrently never leave an unflagged receipt", async () => {
    const ctx = await ctxOf(fx)
    await inTenant(fx, () => Promise.all([
      recordOutcome(ctx, returned("2026-10-28T00:00:00Z"), emptyIngest()),
      recordOutcome(ctx, paid("2026-10-26T00:00:00Z"), emptyIngest()),
    ]))
    const rows = await results()
    const receipt = rows.find((x) => x.outcome === "PAID")!
    const ret = rows.find((x) => x.outcome === "UNPAID")!
    const silent = receipt.paymentId !== null && !ret.reportedAfterPayment && receipt.reviewReason === null
    expect(silent).toBe(false)
  })

  it("L1: replaying a PAID result booked just before a crash links our own receipt without flagging it as already paid", async () => {
    const r = await prisma.collectionResult.create({ data: {
      tenantId: fx.tenantId, provider: "it-flaky", instructionId, resultKey: `${ref}:PAID`, outcome: "PAID", settledAmountCents: 100_000,
      rawPayload: {}, resolvedAt: new Date("2026-10-26T00:00:00Z"), createdAt: new Date("2026-10-27T06:00:00Z"),
    } })
    await prisma.collectionInstruction.update({ where: { id: instructionId, tenantId: fx.tenantId }, data: { status: "PAID" } })
    // The crashed run had booked the receipt under the result's key, then died.
    await inTenant(fx, () => applyManualReceipt(prisma, {
      loanId: fx.loanId, tenantId: fx.tenantId, amount: 100_000, paymentMethod: "DEBIT_ORDER", reference: ref,
      notes: "Debit order collection", capturedById: "collections-engine", capturedByEmail: "system@collections-engine",
      auditUserId: null, idempotencyKey: `collection-result:${r.id}`, receivedAt: new Date("2026-10-26T00:00:00Z"), valueDateSource: "SYSTEM_OBSERVED",
    }))
    expect(await run(fx, "RESULTS")).toMatchObject({ results: { allocated: 1, needsReview: 0 } })
    const payments = await paymentsOf(fx)
    expect(payments).toHaveLength(1)
    expect(await prisma.collectionResult.findFirstOrThrow({ where: { id: r.id, tenantId: fx.tenantId } }))
      .toMatchObject({ paymentId: payments[0].id, reviewReason: null })
  })

  it("L1: the receipt's value date does not depend on when the sweep runs (provider clock ahead of ours)", async () => {
    const r = await prisma.collectionResult.create({ data: {
      tenantId: fx.tenantId, provider: "it-flaky", instructionId, resultKey: `${ref}:PAID`, outcome: "PAID", settledAmountCents: 100_000,
      rawPayload: {}, resolvedAt: new Date("2026-10-27T12:00:00Z"), createdAt: new Date("2026-10-27T06:00:00Z"),
    } })
    await prisma.collectionInstruction.update({ where: { id: instructionId, tenantId: fx.tenantId }, data: { status: "PAID" } })
    await run(fx, "RESULTS")
    const [payment] = await paymentsOf(fx)
    expect(payment.receivedAt.toISOString()).toBe("2026-10-27T06:00:00.000Z")
    expect(payment.idempotencyKey).toBe(`collection-result:${r.id}`)
  })
})
