/**
 * Real-Postgres proof for the round-2 review findings:
 * - N1: a mandate cancelled while its provider call is in flight, or before
 *   registration, is located at the provider by our reference and cancelled
 *   there; a rail that cannot be queried becomes a review item.
 * - L2: registration that never comes becomes a review item.
 * - L3: sweeps and stop rules cover mandates of a provider the tenant has
 *   since switched away from.
 * - L4: an instruction the rail rejected is a review item until acknowledged.
 *
 * GATED: RUN_COLLECTIONS_ENGINE_IT=1, DATABASE_URL to a throwaway migrated Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import { simulatedCollections } from "@/lib/integrations/collections/simulated"
import { cancelDebitMandate, createDebitMandate } from "./mandates"
import { loadReviewQueue, resolveReviewItem } from "./review"
import { activeMandate, at, createFixture, flaky, inTenant, insertInstruction, instructionsOf, resetFlaky, run, type Fixture } from "./collections-engine.it-helpers"

const RUN = process.env.RUN_COLLECTIONS_ENGINE_IT === "1"
const suite = RUN ? describe : describe.skip

suite("collections engine: orphans, timeouts, provider switches (real Postgres)", () => {
  let fx: Fixture
  const staff = () => ({ userId: fx.userId, userEmail: "ce-admin@test.invalid" })
  const mandateRow = (id: string) => prisma.debitMandate.findFirstOrThrow({ where: { id, tenantId: fx.tenantId } })
  const create = () => inTenant(fx, () => createDebitMandate(fx.tenantId, staff(), { loanId: fx.loanId, authType: "TT1", debitDay: 25, trackingDays: 3 }, new Date()))
  /** Staff cancel the mandate while createMandate is still in flight. */
  const cancelMidCall = () => {
    flaky.beforeCreateReturn = async () => {
      flaky.beforeCreateReturn = null
      const m = await prisma.debitMandate.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "SUBMITTING" } })
      await inTenant(fx, () => cancelDebitMandate(fx.tenantId, staff(), m.id, "Client changed banks"))
    }
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
  })

  it("N1: a reference returned after staff cancelled mid-call is kept, and the mandate is cancelled at the provider", async () => {
    flaky.syncRef = true
    cancelMidCall()
    const created = await create().catch(() => null)
    const m = await prisma.debitMandate.findFirstOrThrow({ where: { tenantId: fx.tenantId } })
    expect(created === null || created.status === "CANCELLED").toBe(true)
    expect(m.status).toBe("CANCELLED")
    expect(m.providerMandateRef).toMatch(/^SIM-A-/)
    await run(fx, "SUBMIT")
    expect((await mandateRow(m.id)).providerCancelledAt).not.toBeNull()
    expect(flaky.calls.cancelMandate).toEqual([m.providerMandateRef])
    expect(await simulatedCollections.getMandateStatus(m.providerMandateRef!, {})).toBe("CANCELLED")
  })

  it("N1: a mandate cancelled before the file-based rail registered it is found by our reference and cancelled there", async () => {
    const created = await create()
    expect(created).toMatchObject({ status: "PENDING_REGISTRATION", providerMandateRef: null })
    await inTenant(fx, () => cancelDebitMandate(fx.tenantId, staff(), created.id, "Client withdrew"))
    expect(await run(fx, "SUBMIT")).toMatchObject({ sweeps: { providerCancelled: 1, errors: [] } })
    const m = await mandateRow(created.id)
    expect(m.providerMandateRef).toMatch(/^SIM-A-/)
    expect(m.providerCancelledAt).not.toBeNull()
    expect(await simulatedCollections.getMandateStatus(m.providerMandateRef!, {})).toBe("CANCELLED")
  })

  it("N1: when the rail cannot be queried, the orphan is a review item until staff confirm it with the provider", async () => {
    flaky.noFindMandate = true
    const created = await create()
    await inTenant(fx, () => cancelDebitMandate(fx.tenantId, staff(), created.id, "Client withdrew"))
    await run(fx, "SUBMIT")
    expect((await mandateRow(created.id)).reviewReason).toMatch(/cannot be looked up/)
    const queue = await inTenant(fx, () => loadReviewQueue(fx.tenantId, fx.loanId))
    expect(queue.mandates.map((m) => m.id)).toEqual([created.id])
    await inTenant(fx, () => resolveReviewItem(fx.tenantId, staff(), { kind: "MANDATE", id: created.id, action: "ACKNOWLEDGE" } as never, "Provider confirms no mandate"))
    expect(await mandateRow(created.id)).toMatchObject({ reviewReason: null, providerCancelledAt: expect.any(Date) })
  })

  it("L2: a registration that never comes is put in front of a person", async () => {
    flaky.registerNever = true
    const created = await create()
    at("2026-10-21T06:00:00Z")
    await run(fx, "SUBMIT")
    expect((await mandateRow(created.id)).reviewReason).toBeNull()
    at("2026-10-23T07:00:00Z")
    await run(fx, "SUBMIT")
    expect(await mandateRow(created.id)).toMatchObject({ status: "PENDING_REGISTRATION", reviewReason: expect.stringMatching(/not registered/) })
  })

  it("L3: stop rules and provider cancellation reach mandates of a provider the tenant switched away from", async () => {
    const simFx = await createFixture({ provider: "simulated" })
    fx = simFx
    const mandateId = await activeMandate(fx)
    const a = await insertInstruction(fx, mandateId, { row: 1, presentmentNo: 1, status: "UNPAID", actionDate: "2026-09-25", amountCents: 100_000 })
    const b = await insertInstruction(fx, mandateId, { row: 1, presentmentNo: 2, status: "UNPAID", actionDate: "2026-10-19", amountCents: 100_000 })
    for (const [i, d] of [[a, "2026-09-25"], [b, "2026-10-19"]] as const) {
      await prisma.collectionResult.create({ data: {
        tenantId: fx.tenantId, provider: "simulated", instructionId: i.id, resultKey: `${i.id}:UNPAID`, outcome: "UNPAID",
        reasonCode: "INSUFFICIENT_FUNDS", rawPayload: {}, resolvedAt: new Date(`${d}T00:00:00Z`), processedAt: new Date(),
      } })
    }
    await prisma.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { collectionProvider: "it-flaky" } })
    await run(fx, "RESULTS")
    const m = await mandateRow(mandateId)
    expect(m.status).toBe("SUSPENDED")
    expect(m.providerCancelledAt).not.toBeNull()
    expect(await simulatedCollections.getMandateStatus(m.providerMandateRef!, {})).toBe("CANCELLED")
  })

  it("L4: an instruction the rail rejected waits in the review queue until acknowledged", async () => {
    await activeMandate(fx)
    flaky.rejectAll = "Account frozen (ref 62000000001)"
    await run(fx, "SUBMIT")
    const [i] = await instructionsOf(fx)
    expect(i).toMatchObject({ status: "REJECTED", statusReason: "Account frozen (ref [redacted])" })
    const queue = await inTenant(fx, () => loadReviewQueue(fx.tenantId))
    expect(queue.instructions.map((x) => x.id)).toEqual([i.id])
    await inTenant(fx, () => resolveReviewItem(fx.tenantId, staff(), { kind: "INSTRUCTION", id: i.id, action: "ACKNOWLEDGE" } as never, "Client to pay by EFT"))
    expect((await inTenant(fx, () => loadReviewQueue(fx.tenantId))).instructions).toEqual([])
  })
})
