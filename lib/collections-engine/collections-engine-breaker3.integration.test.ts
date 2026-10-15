/**
 * Real-Postgres repros from the third breaker pass (all written red-first):
 * - A: a load report that leaves out a reference never strands it UPLOADED.
 * - B: a second PAID with its own provider id is a possible double debit for
 *   review, not a silent duplicate; RELEASE without a provider lookup needs an
 *   explicit staff confirmation.
 * - C: EXPIRED / REJECTED / SUSPENDED reported for an ACTIVE mandate stop it,
 *   cancel its unsubmitted instructions and raise a review item.
 * - D: a unique violation that is not the result key is not mistaken for a
 *   duplicate: the outcome is recorded for review.
 * - Extras: acknowledging an unbooked mismatch needs a receipt or "no money
 *   received"; a registration without a reference is a review item.
 *
 * GATED: RUN_COLLECTIONS_ENGINE_IT=1, DATABASE_URL to a throwaway migrated Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { applyManualReceipt } from "@/lib/loan/apply-payment"
import type { CollectionOutcome } from "@/lib/integrations/collections/types"
import { createDebitMandate } from "./mandates"
import { emptyIngest, recordOutcome } from "./results"
import { resolveReviewItem, type ReviewAction } from "./review"
import { CollectionProviderError } from "@/lib/integrations/collections/types"
import { activeMandate, at, createFixture, ctxOf, flaky, inTenant, insertInstruction, instructionsOf, paymentsOf, resetFlaky, run, type Fixture } from "./collections-engine.it-helpers"

const RUN = process.env.RUN_COLLECTIONS_ENGINE_IT === "1"
const suite = RUN ? describe : describe.skip

suite("collections engine: third breaker pass (real Postgres)", () => {
  let fx: Fixture
  const staff = () => ({ userId: fx.userId, userEmail: "ce-admin@test.invalid" })
  const resolve = (item: ReviewAction, reason = "Checked with the provider") => inTenant(fx, () => resolveReviewItem(fx.tenantId, staff(), item, reason))
  const paid = (ref: string, providerResultId: string, settled = 100_000, resolved = "2026-10-26T00:00:00Z"): CollectionOutcome => ({
    instructionRef: ref, status: "PAID", reason: null, rawCode: "OK", settledAmountCents: settled, resolvedAt: new Date(resolved), providerResultId,
  })
  const record = async (o: CollectionOutcome) => {
    const summary = emptyIngest()
    await inTenant(fx, async () => recordOutcome(await ctxOf(fx), o, summary))
    return summary
  }

  beforeAll(() => vi.useFakeTimers({ toFake: ["Date"] }))
  afterAll(async () => {
    vi.useRealTimers()
    await prisma.$disconnect()
  })
  beforeEach(async () => {
    resetFlaky()
    at("2026-10-20T06:00:00Z")
    fx = await createFixture({ provider: "it-flaky", instalments: [100_000, 100_000], dueDates: ["2026-10-25", "2026-10-25"] })
  })

  it("A: an instruction the load report leaves out goes to review instead of staying UPLOADED forever", async () => {
    await activeMandate(fx)
    flaky.omitFromLoadReport = true
    await run(fx, "SUBMIT")
    const rows = await instructionsOf(fx)
    expect(rows.map((i) => i.status).sort()).toEqual(["NEEDS_REVIEW", "SUBMITTED"])
    expect(rows.find((i) => i.status === "NEEDS_REVIEW")!.statusReason).toMatch(/not in the provider's load report/i)
    expect(await prisma.collectionBatch.findFirst({ where: { tenantId: fx.tenantId } })).toMatchObject({ status: "NEEDS_REVIEW" })
  })

  it("B: a second PAID with its own provider id for the same debit is a possible double debit, not a silent duplicate", async () => {
    const mandateId = await activeMandate(fx)
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-26", amountCents: 100_000 })
    at("2026-10-29T06:00:00Z")
    await record(paid(i.instructionRef, "TXN-1"))
    expect((await record(paid(i.instructionRef, "TXN-1"))).duplicates).toBe(1)
    const second = await record(paid(i.instructionRef, "TXN-2", 100_000, "2026-10-27T00:00:00Z"))
    expect(second).toMatchObject({ recorded: 1, duplicates: 0 })
    expect(await paymentsOf(fx)).toHaveLength(1)
    const results = await prisma.collectionResult.findMany({ where: { tenantId: fx.tenantId }, orderBy: { resolvedAt: "asc" } })
    expect(results).toHaveLength(2)
    expect(results[1]).toMatchObject({ paymentId: null, reviewReason: expect.stringMatching(/possible double debit/i) })
  })

  it("B: RELEASE on a rail that cannot be asked needs the staff member's explicit confirmation, which is audited", async () => {
    await activeMandate(fx)
    flaky.collectError = new CollectionProviderError("PROVIDER_ERROR", "timeout")
    await run(fx, "SUBMIT")
    flaky.collectError = null
    at("2026-10-20T09:00:00Z")
    await run(fx, "SUBMIT")
    const stuck = (await instructionsOf(fx)).find((i) => i.status === "NEEDS_REVIEW")!
    await expect(resolve({ kind: "INSTRUCTION", id: stuck.id, action: "RELEASE" })).rejects.toMatchObject({ code: "INVALID_STATE" })
    await resolve({ kind: "INSTRUCTION", id: stuck.id, action: "RELEASE", confirmedNotSent: true })
    expect(await prisma.auditLog.findFirst({ where: { tenantId: fx.tenantId, action: "COLLECTION_REVIEW_RESOLVED", entityId: stuck.id } }))
      .toMatchObject({ newValue: expect.objectContaining({ confirmedNotSent: true }) })
  })

  it.each(["EXPIRED", "REJECTED", "SUSPENDED"] as const)("C: %s reported for an ACTIVE mandate stops it, cancels its queued debit and asks for review", async (status) => {
    const mandateId = await activeMandate(fx)
    await insertInstruction(fx, mandateId, { row: 1, actionDate: "2026-10-26", amountCents: 100_000 })
    flaky.mandateStatus = status
    await run(fx, "SUBMIT")
    // SUSPENDED is applied on the second consecutive report (collections-engine-breaker4).
    if (status === "SUSPENDED") await run(fx, "SUBMIT")
    expect(await prisma.debitMandate.findFirstOrThrow({ where: { id: mandateId, tenantId: fx.tenantId } }))
      .toMatchObject({ status, reviewReason: expect.stringMatching(new RegExp(`reported ${status}`)) })
    const queued = (await instructionsOf(fx)).find((i) => i.installmentNo === 1)!
    expect(queued.status).toBe("CANCELLED")
    expect(await prisma.collectionBatch.count({ where: { tenantId: fx.tenantId } })).toBe(0)
  })

  it("D: an outcome for an instruction whose presentment was replaced is recorded for review, not dropped as a duplicate", async () => {
    const mandateId = await activeMandate(fx)
    const old = await insertInstruction(fx, mandateId, { row: 1, status: "CANCELLED", actionDate: "2026-10-19", amountCents: 100_000 })
    await insertInstruction(fx, mandateId, { row: 1, actionDate: "2026-10-26", amountCents: 100_000 })
    at("2026-10-29T06:00:00Z")
    const summary = await record(paid(old.instructionRef, "TXN-OLD", 100_000, "2026-10-19T00:00:00Z"))
    expect(summary).toMatchObject({ duplicates: 0, recorded: 1 })
    expect(await prisma.collectionResult.findFirst({ where: { tenantId: fx.tenantId } }))
      .toMatchObject({ paymentId: null, reviewReason: expect.any(String) })
    expect(await paymentsOf(fx)).toHaveLength(0)
  })

  it("Extra: an unbooked mismatch is acknowledged only against a receipt or an explicit 'no money received'", async () => {
    const mandateId = await activeMandate(fx)
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-26", amountCents: 100_000 })
    at("2026-10-29T06:00:00Z")
    await record(paid(i.instructionRef, "TXN-M", 90_000))
    const result = await prisma.collectionResult.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    await expect(resolve({ kind: "RESULT", id: result.id, action: "ACKNOWLEDGE" })).rejects.toMatchObject({ code: "INVALID_STATE" })
    const manual = await inTenant(fx, () => applyManualReceipt(prisma, { loanId: fx.loanId, tenantId: fx.tenantId, amount: 90_000, capturedById: fx.userId }))
    await resolve({ kind: "RESULT", id: result.id, action: "ACKNOWLEDGE", paymentId: manual.payment.id })
    expect(await prisma.collectionResult.findFirstOrThrow({ where: { id: result.id, tenantId: fx.tenantId } }))
      .toMatchObject({ paymentId: manual.payment.id, reviewResolvedAt: expect.any(Date) })
  })

  it("Extra: 'no money received' resolves an unbooked mismatch and is audited", async () => {
    const mandateId = await activeMandate(fx)
    const i = await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-26", amountCents: 100_000 })
    at("2026-10-29T06:00:00Z")
    await record(paid(i.instructionRef, "TXN-N", 90_000))
    const result = await prisma.collectionResult.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    await resolve({ kind: "RESULT", id: result.id, action: "ACKNOWLEDGE", noMoneyReceived: true })
    expect(await prisma.auditLog.findFirst({ where: { tenantId: fx.tenantId, action: "COLLECTION_REVIEW_RESOLVED", entityId: result.id } }))
      .toMatchObject({ newValue: expect.objectContaining({ noMoneyReceived: true }) })
  })

  it("Extra: a registration reported without a reference is a review item", async () => {
    flaky.registeredWithoutRef = true
    const created = await inTenant(fx, () => createDebitMandate(fx.tenantId, staff(), { loanId: fx.loanId, authType: "TT1", debitDay: 25, trackingDays: 3 }, new Date()))
    await run(fx, "SUBMIT")
    expect(await prisma.debitMandate.findFirstOrThrow({ where: { id: created.id, tenantId: fx.tenantId } }))
      .toMatchObject({ reviewReason: expect.stringMatching(/without a reference/) })
  })
})
