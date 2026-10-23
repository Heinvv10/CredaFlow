/**
 * Round-3 edge cases on real Postgres (docs/asset-finance/SLICE5.md part B), asserting the fixed behaviour:
 * the tenure ends by this loan's own dated records (a lessor-status stamp alone ends nothing), the poll
 * selects devices by its own clock, and the database's "not yet" defers an event.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/edge-round3.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { SAST_OFFSET_MS } from "@/lib/date/sast"
import { pollTenant } from "./poll"
import { simulatedTelematics } from "./providers/simulated"
import { edgeHelpers, heartbeat, positionEvent } from "./edge.integration-fixture"
import { cleanupTelematicsFixture, createTelematicsFixture, daysAgo, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
vi.mock("@/lib/rate-limit", async (original) => ({ ...(await original<typeof import("@/lib/rate-limit")>()), checkRateLimit: () => ({ allowed: true, remaining: 99, retryAfterSeconds: 0 }) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const { leaseWithDevice, ingest, asTestSetup } = edgeHelpers(database, () => fx, setSession)
const loanAt = async (assetId: string, at: Date) =>
  (await database().$queryRaw<{ id: string | null }[]>`SELECT public."telematicsLoanAt"(${fx.tenantId}, ${assetId}, ${at.toISOString()}::timestamptz AT TIME ZONE 'UTC') AS id`)[0].id

suite.sequential("telematics round-3 edge cases (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
  }, 600_000)
  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("tenure ends on the day this loan's return was inspected, not at a lessor-status stamp", async () => {
    const d = await leaseWithDevice()
    // A status stamp alone (as a withdrawn recovery or an earlier lease leaves it) ends nothing.
    await asTestSetup([`UPDATE "FinancedAsset" SET "lessorStatus" = 'RETURNED_TO_STOCK', "lessorStatusAt" = now() - INTERVAL '1 hour' WHERE "id" = $1`, d.assetId])
    expect(await loanAt(d.assetId, new Date())).toBe(d.loanId)
    // The return inspected yesterday (SAST): covered until that day began, not from it.
    await asTestSetup([`INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "status", "inspectedOn", "inspectedById", "inspectionCondition", "updatedAt")
      VALUES (gen_random_uuid()::text, $1, $2, 'EXPIRY', 'RETURN', 'INSPECTED', $3::date, $4, 'Synthetic: returned', now())`, fx.tenantId, d.loanId, daysAgo(1), fx.officer])
    const dayStart = new Date(Date.parse(`${daysAgo(1)}T00:00:00.000Z`) - SAST_OFFSET_MS)
    expect(await loanAt(d.assetId, new Date(dayStart.getTime() - 1))).toBe(d.loanId)
    expect(await loanAt(d.assetId, dayStart)).toBeNull()
  }, 300_000)

  it("the poll selects devices by its own clock: a past poll before the lease began does not ask for the device", async () => {
    const d = await leaseWithDevice()
    const loan = await database().loan.findUniqueOrThrow({ where: { id: d.loanId } })
    const spy = vi.spyOn(simulatedTelematics, "poll").mockResolvedValue({ events: [], cursors: {}, simulated: true })
    const asked = () => spy.mock.calls.some(([input]) => input.devices.some((x) => x.externalDeviceId === d.externalDeviceId))
    await pollTenant(fx.tenantId, new Date(loan.startDate.getTime() - 2 * 86_400_000))
    expect(asked()).toBe(false)
    await pollTenant(fx.tenantId, new Date())
    expect(asked()).toBe(true)
    vi.restoreAllMocks()
  }, 300_000)

  it("an event the database's clock has not reached yet waits (deferred, cursor kept) even when the poll's clock has", async () => {
    const d = await leaseWithDevice()
    const at = new Date(Date.now() + 7 * 60_000)
    vi.spyOn(simulatedTelematics, "poll").mockResolvedValue({ events: [heartbeat(d.externalDeviceId, at)], cursors: { [d.externalDeviceId]: at.toISOString() }, simulated: true })
    // The poll's clock runs ten minutes ahead of the database's.
    expect(await pollTenant(fx.tenantId, new Date(Date.now() + 10 * 60_000))).toMatchObject({ deferred: 1, rejected: 0, failed: 0 })
    expect(await database().trackerDevice.findUniqueOrThrow({ where: { id: d.deviceId } })).toMatchObject({ pollCursor: null })
    vi.restoreAllMocks()
  }, 300_000)

  it("a status stamped before the loan began (an earlier tenant's return) does not end the new loan's tenure", async () => {
    const d = await leaseWithDevice()
    const loan = await database().loan.findUniqueOrThrow({ where: { id: d.loanId } })
    await asTestSetup([`UPDATE "FinancedAsset" SET "lessorStatus" = 'RETURNED_TO_STOCK', "lessorStatusAt" = $2::timestamptz WHERE "id" = $1`, d.assetId, new Date(loan.startDate.getTime() - 1).toISOString()])
    expect(await loanAt(d.assetId, new Date())).toBe(d.loanId)
    expect(await ingest(d.deviceId, positionEvent(d.externalDeviceId, new Date(Date.now() - 60_000)))).toMatchObject({ stored: true, positionStored: true })
  }, 300_000)

  it("a status stamped on the loan's own start instant ends nothing", async () => {
    const d = await leaseWithDevice()
    const loan = await database().loan.findUniqueOrThrow({ where: { id: d.loanId } })
    await asTestSetup([`UPDATE "FinancedAsset" SET "lessorStatus" = 'RETURNED_TO_STOCK', "lessorStatusAt" = $2::timestamptz WHERE "id" = $1`, d.assetId, loan.startDate.toISOString()])
    // A return that was recorded in the same instant as the new loan began belongs to the previous tenant.
    expect(await loanAt(d.assetId, new Date())).toBe(d.loanId)
  }, 300_000)
})
