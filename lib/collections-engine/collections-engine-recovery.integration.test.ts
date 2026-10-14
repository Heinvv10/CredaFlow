/**
 * Real-Postgres proof that the engine never re-sends what may have reached the
 * bank, and never gets stuck:
 * - T1: a definitely-not-sent submit failure releases the instructions; an
 *   ambiguous one leaves them SUBMITTING and does not re-send them.
 * - H3 (breaker REPRO 4): a stuck SUBMITTING instruction is reconciled — by
 *   provider lookup where supported, else NEEDS_REVIEW — and a staff RELEASE
 *   (audited) sends it again.
 * - M3: a staff create and the cron cannot both call createMandate.
 * - M4: failed mandate submissions back off and stop at a review item; RETRY resumes.
 *
 * GATED: RUN_COLLECTIONS_ENGINE_IT=1, DATABASE_URL to a throwaway migrated Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { CollectionProviderError } from "@/lib/integrations/collections/types"
import { tenantRunErrors } from "./cron"
import { submitMandate } from "./mandate-lifecycle"
import { resolveReviewItem } from "./review"
import { createDebitMandate } from "./mandates"
import { MAX_SUBMIT_ATTEMPTS } from "./scheme-rules"
import { activeMandate, at, createFixture, ctxOf, flaky, inTenant, instructionsOf, resetFlaky, run, type Fixture } from "./collections-engine.it-helpers"

const RUN = process.env.RUN_COLLECTIONS_ENGINE_IT === "1"
const suite = RUN ? describe : describe.skip

suite("collections engine recovery (real Postgres)", () => {
  let fx: Fixture
  const staff = () => ({ userId: fx.userId, userEmail: "ce-admin@test.invalid" })
  const timeout = () => new CollectionProviderError("PROVIDER_ERROR", "socket hang up after 30000 ms, account 62000000001")

  beforeAll(() => vi.useFakeTimers({ toFake: ["Date"] }))
  afterAll(async () => {
    vi.useRealTimers()
    await prisma.$disconnect()
  })
  beforeEach(async () => {
    resetFlaky()
    at("2026-10-20T06:00:00Z")
    fx = await createFixture({ provider: "it-flaky" })
    await activeMandate(fx)
  })

  it("T1: a definitely-not-sent failure releases the claimed instructions to PENDING, and the next run sends them", async () => {
    flaky.collectError = new CollectionProviderError("NOT_CONFIGURED", "no debit-order key")
    const first = await run(fx, "SUBMIT")
    expect(tenantRunErrors(first)).toHaveLength(1)
    const [i] = await instructionsOf(fx)
    expect(i).toMatchObject({ status: "PENDING", batchId: null })
    expect(await prisma.collectionBatch.findFirst({ where: { tenantId: fx.tenantId } })).toMatchObject({ status: "FAILED" })

    flaky.collectError = null
    await run(fx, "SUBMIT")
    expect((await instructionsOf(fx))[0].status).toBe("SUBMITTED")
    expect(flaky.calls.collect).toEqual([[i.instructionRef], [i.instructionRef]])
  })

  it("T1/H3: an ambiguous failure leaves the instruction SUBMITTING, never re-sends it, then puts it before a person", async () => {
    flaky.collectError = timeout()
    await run(fx, "SUBMIT")
    const [i] = await instructionsOf(fx)
    expect(i.status).toBe("SUBMITTING")
    const batch = await prisma.collectionBatch.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    expect(batch.error).not.toMatch(/62000000001/)

    flaky.collectError = null
    at("2026-10-20T07:00:00Z")
    await run(fx, "SUBMIT")
    expect((await instructionsOf(fx))[0].status).toBe("SUBMITTING")
    at("2026-10-20T09:00:00Z")
    expect(await run(fx, "SUBMIT")).toMatchObject({ reconcile: { needsReview: 1 } })
    expect((await instructionsOf(fx))[0]).toMatchObject({ status: "NEEDS_REVIEW", statusReason: expect.stringMatching(/outcome unknown/) })
    expect(flaky.calls.collect).toHaveLength(1)
    expect((await prisma.collectionBatch.findFirstOrThrow({ where: { id: batch.id, tenantId: fx.tenantId } })).status).toBe("NEEDS_REVIEW")

    await inTenant(fx, () => resolveReviewItem(fx.tenantId, staff(), { kind: "INSTRUCTION", id: i.id, action: "RELEASE" }, "Provider confirms it never received the batch"))
    expect((await instructionsOf(fx))[0].status).toBe("PENDING")
    expect(await prisma.auditLog.count({ where: { tenantId: fx.tenantId, action: "COLLECTION_REVIEW_RESOLVED", entityId: i.id, userId: fx.userId } })).toBe(1)
    await run(fx, "SUBMIT")
    expect((await instructionsOf(fx))[0].status).toBe("SUBMITTED")
    expect(flaky.calls.collect).toHaveLength(2)
  })

  it("H3: a stuck instruction the provider never received is released and sent; one it has is marked submitted", async () => {
    flaky.collectError = timeout()
    await run(fx, "SUBMIT")
    flaky.collectError = null
    flaky.findInstruction = () => ({ state: "NOT_FOUND" })
    at("2026-10-20T09:00:00Z")
    expect(await run(fx, "SUBMIT")).toMatchObject({ reconcile: { released: 1 } })
    expect((await instructionsOf(fx))[0].status).toBe("SUBMITTED")
    expect(flaky.calls.collect).toHaveLength(2)

    resetFlaky()
    const other = await createFixture({ provider: "it-flaky" })
    fx = other
    await activeMandate(fx)
    flaky.collectError = timeout()
    await run(fx, "SUBMIT")
    flaky.collectError = null
    flaky.findInstruction = () => ({ state: "ACCEPTED" })
    at("2026-10-20T11:30:00Z")
    expect(await run(fx, "SUBMIT")).toMatchObject({ reconcile: { settled: 1 } })
    expect((await instructionsOf(fx))[0].status).toBe("SUBMITTED")
    expect(flaky.calls.collect).toHaveLength(1)
  })

  it("M3: a staff submit and the cron claim the mandate once: createMandate is called once", async () => {
    const m = await prisma.debitMandate.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    await inTenant(fx, () => prisma.$executeRawUnsafe(`UPDATE "DebitMandate" SET status = 'CANCELLED' WHERE id = $1`, m.id))
    flaky.createMandateError = timeout()
    const created = await inTenant(fx, () => createDebitMandate(fx.tenantId, staff(), { loanId: fx.loanId, authType: "TT1", debitDay: 25, trackingDays: 3 }, new Date()))
    expect(created).toMatchObject({ status: "CREATED", submitAttempts: 1 })
    flaky.createMandateError = null
    flaky.calls.createMandate = 0
    at("2026-10-20T08:00:00Z")
    const ctx = await ctxOf(fx)
    const outcomes = await inTenant(fx, () => Promise.all([submitMandate(ctx, created.id), submitMandate(ctx, created.id)]))
    expect(outcomes.filter((o) => o === null)).toHaveLength(1)
    expect(flaky.calls.createMandate).toBe(1)
  })

  it("M4: failed submissions back off, stop at a review item after the limit, and RETRY resumes them", async () => {
    const m = await prisma.debitMandate.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    await inTenant(fx, () => prisma.$executeRawUnsafe(`UPDATE "DebitMandate" SET status = 'CANCELLED' WHERE id = $1`, m.id))
    flaky.createMandateError = timeout()
    flaky.calls.createMandate = 0
    const created = await inTenant(fx, () => createDebitMandate(fx.tenantId, staff(), { loanId: fx.loanId, authType: "TT1", debitDay: 25, trackingDays: 3 }, new Date()))
    at("2026-10-20T06:30:00Z")
    await run(fx, "SUBMIT")
    expect(flaky.calls.createMandate).toBe(1)
    let now = new Date("2026-10-20T06:00:00Z")
    for (let attempt = 2; attempt <= MAX_SUBMIT_ATTEMPTS + 2; attempt++) {
      const row = await prisma.debitMandate.findFirstOrThrow({ where: { id: created.id, tenantId: fx.tenantId } })
      now = row.nextAttemptAt ?? new Date(now.getTime() + 86_400_000)
      at(now.toISOString())
      await run(fx, "SUBMIT")
    }
    const stopped = await prisma.debitMandate.findFirstOrThrow({ where: { id: created.id, tenantId: fx.tenantId } })
    expect(stopped).toMatchObject({ status: "CREATED", submitAttempts: MAX_SUBMIT_ATTEMPTS, reviewReason: expect.stringMatching(/failed 5 times/) })
    expect(flaky.calls.createMandate).toBe(MAX_SUBMIT_ATTEMPTS)

    flaky.createMandateError = null
    await inTenant(fx, () => resolveReviewItem(fx.tenantId, staff(), { kind: "MANDATE", id: created.id, action: "RETRY" }, "Provider outage is over"))
    await run(fx, "SUBMIT")
    expect((await prisma.debitMandate.findFirstOrThrow({ where: { id: created.id, tenantId: fx.tenantId } })).status).toBe("ACTIVE")
  })

  it("R3: RELEASE is refused when the provider, asked again, says it has the instruction", async () => {
    flaky.collectError = timeout()
    await run(fx, "SUBMIT")
    flaky.collectError = null
    at("2026-10-20T09:00:00Z")
    await run(fx, "SUBMIT")
    const [i] = await instructionsOf(fx)
    expect(i.status).toBe("NEEDS_REVIEW")
    flaky.findInstruction = () => ({ state: "ACCEPTED" })
    await expect(inTenant(fx, () => resolveReviewItem(fx.tenantId, staff(), { kind: "INSTRUCTION", id: i.id, action: "RELEASE" }, "Looks lost")))
      .rejects.toMatchObject({ code: "INVALID_STATE", message: expect.stringMatching(/provider has it/) })
    expect((await instructionsOf(fx))[0].status).toBe("NEEDS_REVIEW")
    flaky.findInstruction = () => ({ state: "NOT_FOUND" })
    await inTenant(fx, () => resolveReviewItem(fx.tenantId, staff(), { kind: "INSTRUCTION", id: i.id, action: "RELEASE" }, "Provider confirms not received"))
    expect((await instructionsOf(fx))[0].status).toBe("PENDING")
  })
})
