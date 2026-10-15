/**
 * Real-Postgres repros from the fourth breaker pass (red-first):
 * - F: on a rail that gives no result id, a second PAID with the same key for
 *   an instruction that was released and sent again is a possible double
 *   debit, not a duplicate.
 * - G: acknowledging an unbooked payment against a receipt requires the
 *   receipt to match the settled amount (or the debit amount, with a reason)
 *   and to be dated on or after the action date.
 * - SUSPENDED reported for an ACTIVE mandate is applied only when two
 *   consecutive refreshes report it; the first raises a review item only.
 *
 * GATED: RUN_COLLECTIONS_ENGINE_IT=1, DATABASE_URL to a throwaway migrated Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import type { CollectionOutcome } from "@/lib/integrations/collections/types"
import { emptyIngest, recordOutcome } from "./results"
import { resolveReviewItem, type ReviewAction } from "./review"
import { activeMandate, at, createFixture, ctxOf, flaky, inTenant, insertInstruction, paymentsOf, resetFlaky, run, type Fixture } from "./collections-engine.it-helpers"

const RUN = process.env.RUN_COLLECTIONS_ENGINE_IT === "1"
const suite = RUN ? describe : describe.skip

suite("collections engine: fourth breaker pass (real Postgres)", () => {
  let fx: Fixture
  let mandateId: string
  const staff = () => ({ userId: fx.userId, userEmail: "ce-admin@test.invalid" })
  const resolve = (item: ReviewAction, reason = "Checked with the provider") => inTenant(fx, () => resolveReviewItem(fx.tenantId, staff(), item, reason))
  const paidNoId = (ref: string, settled = 100_000): CollectionOutcome => ({
    instructionRef: ref, status: "PAID", reason: null, rawCode: "OK", settledAmountCents: settled, resolvedAt: new Date("2026-10-26T00:00:00Z"),
  })
  const record = async (o: CollectionOutcome) => {
    const summary = emptyIngest()
    await inTenant(fx, async () => recordOutcome(await ctxOf(fx), o, summary))
    return summary
  }
  const receipt = (amount: number, receivedAt: string) => inTenant(fx, () => applyManualReceipt(prisma, {
    loanId: fx.loanId, tenantId: fx.tenantId, amount, capturedById: fx.userId, receivedAt: new Date(receivedAt),
  }))
  /** An unbooked mismatch result (settled 90 000 against a debit of 100 000 for 26 Oct). */
  const mismatch = async () => {
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-26", amountCents: 100_000 })
    await record({ ...paidNoId(i.instructionRef, 90_000), providerResultId: "TXN-M" })
    return prisma.collectionResult.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
  }

  beforeAll(() => vi.useFakeTimers({ toFake: ["Date"] }))
  afterAll(async () => {
    vi.useRealTimers()
    await prisma.$disconnect()
  })
  beforeEach(async () => {
    resetFlaky()
    at("2026-10-20T06:00:00Z")
    fx = await createFixture({ provider: "it-flaky" })
    mandateId = await activeMandate(fx)
    at("2026-10-29T06:00:00Z")
  })

  it("F: a second PAID with the same key for a released and resent debit is a possible double debit", async () => {
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-26", amountCents: 100_000 })
    await prisma.collectionInstruction.update({ where: { id: i.id, tenantId: fx.tenantId }, data: { releasedAt: new Date("2026-10-21T06:00:00Z") } })
    await record(paidNoId(i.instructionRef))
    expect(await record(paidNoId(i.instructionRef))).toMatchObject({ duplicates: 0, needsReview: 1 })
    expect(await paymentsOf(fx)).toHaveLength(1)
    const rows = await prisma.collectionResult.findMany({ where: { tenantId: fx.tenantId }, orderBy: { createdAt: "asc" } })
    expect(rows).toHaveLength(2)
    expect(rows[1]).toMatchObject({ paymentId: null, reviewReason: expect.stringMatching(/possible double debit/i) })
  })

  it("F: the same report again for a debit never released is still a duplicate", async () => {
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-26", amountCents: 100_000 })
    await record(paidNoId(i.instructionRef))
    expect(await record(paidNoId(i.instructionRef))).toMatchObject({ duplicates: 1, needsReview: 0 })
  })

  it("G: a receipt whose amount matches neither the settlement nor (with a reason) the debit is refused", async () => {
    const result = await mismatch()
    const wrong = await receipt(80_000, "2026-10-27T00:00:00Z")
    await expect(resolve({ kind: "RESULT", id: result.id, action: "ACKNOWLEDGE", paymentId: wrong.payment.id })).rejects.toMatchObject({ code: "INVALID_STATE" })
  })

  it("G: a receipt for the debit amount needs an explicit reason, which is audited", async () => {
    const result = await mismatch()
    const full = await receipt(100_000, "2026-10-27T00:00:00Z")
    await expect(resolve({ kind: "RESULT", id: result.id, action: "ACKNOWLEDGE", paymentId: full.payment.id })).rejects.toMatchObject({ code: "INVALID_STATE" })
    await resolve({ kind: "RESULT", id: result.id, action: "ACKNOWLEDGE", paymentId: full.payment.id, amountOverrideReason: "Bank statement shows the full debit settled" })
    expect(await prisma.auditLog.findFirst({ where: { tenantId: fx.tenantId, action: "COLLECTION_REVIEW_RESOLVED", entityId: result.id } }))
      .toMatchObject({ newValue: expect.objectContaining({ amountOverrideReason: "Bank statement shows the full debit settled" }) })
  })

  it("G: a receipt dated before the debit's action date is refused", async () => {
    const result = await mismatch()
    const early = await receipt(90_000, "2026-10-21T00:00:00Z")
    await expect(resolve({ kind: "RESULT", id: result.id, action: "ACKNOWLEDGE", paymentId: early.payment.id })).rejects.toMatchObject({ code: "INVALID_STATE" })
  })

  it("SUSPENDED reported once raises a review item only; a second consecutive report applies it", async () => {
    flaky.mandateStatus = "SUSPENDED"
    at("2026-10-20T07:00:00Z")
    await run(fx, "SUBMIT")
    expect(await prisma.debitMandate.findFirstOrThrow({ where: { id: mandateId, tenantId: fx.tenantId } }))
      .toMatchObject({ status: "ACTIVE", reviewReason: expect.stringMatching(/SUSPENDED/) })
    expect(await prisma.collectionBatch.count({ where: { tenantId: fx.tenantId } })).toBe(0)
    await run(fx, "SUBMIT")
    expect((await prisma.debitMandate.findFirstOrThrow({ where: { id: mandateId, tenantId: fx.tenantId } })).status).toBe("SUSPENDED")
  })

  it("an ACTIVE report in between resets the count", async () => {
    flaky.mandateStatus = "SUSPENDED"
    at("2026-10-20T07:00:00Z")
    await run(fx, "SUBMIT")
    flaky.mandateStatus = "AUTHENTICATED"
    await run(fx, "SUBMIT")
    flaky.mandateStatus = "SUSPENDED"
    await run(fx, "SUBMIT")
    expect((await prisma.debitMandate.findFirstOrThrow({ where: { id: mandateId, tenantId: fx.tenantId } })).status).toBe("ACTIVE")
  })
})
