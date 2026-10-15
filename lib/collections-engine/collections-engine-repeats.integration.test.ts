/**
 * F1: a provider repeating an UNPAID or DISPUTED for the same instruction
 * (a different provider id or date) is recorded, but is not a second unpaid,
 * a second note, a second review item or a second NPF.
 *
 * GATED: RUN_COLLECTIONS_ENGINE_IT=1, DATABASE_URL to a throwaway migrated Postgres.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { prisma } from "@/lib/prisma"
import type { CollectionOutcome } from "@/lib/integrations/collections/types"
import { emptyIngest, recordOutcome } from "./results"
import { activeMandate, at, createFixture, ctxOf, inTenant, insertInstruction, resetFlaky, type Fixture } from "./collections-engine.it-helpers"

const RUN = process.env.RUN_COLLECTIONS_ENGINE_IT === "1"
const suite = RUN ? describe : describe.skip

suite("collections engine: repeated unpaid / disputed reports (real Postgres)", () => {
  let fx: Fixture
  let mandateId: string
  let ref: string
  const report = (status: "UNPAID" | "DISPUTED", providerResultId: string, resolved: string): CollectionOutcome => ({
    instructionRef: ref, status, reason: status === "UNPAID" ? "INSUFFICIENT_FUNDS" : "PAYMENT_STOPPED", rawCode: "R",
    settledAmountCents: null, resolvedAt: new Date(resolved), providerResultId,
  })
  const record = async (o: CollectionOutcome) => {
    const summary = emptyIngest()
    await inTenant(fx, async () => recordOutcome(await ctxOf(fx), o, summary))
    return summary
  }
  const notes = (type: string) => prisma.loanNote.count({ where: { tenantId: fx.tenantId, type } })

  beforeAll(() => vi.useFakeTimers({ toFake: ["Date"] }))
  afterAll(async () => {
    vi.useRealTimers()
    await prisma.$disconnect()
  })
  beforeEach(async () => {
    resetFlaky()
    at("2026-10-20T06:00:00Z")
    fx = await createFixture()
    mandateId = await activeMandate(fx)
    ref = (await insertInstruction(fx, mandateId, { row: 1, status: "SUBMITTED", actionDate: "2026-10-26", amountCents: 100_000 })).instructionRef
    at("2026-10-30T06:00:00Z")
  })

  it("a repeated NPF for one debit is one unpaid and one NPF: the mandate stays ACTIVE", async () => {
    await record(report("UNPAID", "TXN-1", "2026-10-26T00:00:00Z"))
    expect(await record(report("UNPAID", "TXN-2", "2026-10-27T00:00:00Z"))).toMatchObject({ recorded: 1, suspended: 0, needsReview: 0 })
    expect(await prisma.collectionResult.count({ where: { tenantId: fx.tenantId } })).toBe(2)
    expect(await notes("debit_order_unpaid")).toBe(1)
    expect((await prisma.debitMandate.findFirstOrThrow({ where: { id: mandateId, tenantId: fx.tenantId } })).status).toBe("ACTIVE")
  })

  it("a repeated dispute for one debit raises one note and one review item", async () => {
    await record(report("DISPUTED", "TXN-1", "2026-10-26T00:00:00Z"))
    await record(report("DISPUTED", "TXN-2", "2026-10-28T00:00:00Z"))
    const rows = await prisma.collectionResult.findMany({ where: { tenantId: fx.tenantId }, orderBy: { resolvedAt: "asc" } })
    expect(rows.map((r) => r.reviewReason !== null)).toEqual([true, false])
    expect(await notes("debit_order_unpaid")).toBe(1)
  })
})
