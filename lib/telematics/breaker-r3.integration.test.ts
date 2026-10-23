/**
 * Round-3 policy-breaker repros for PR #222 (docs/asset-finance/SLICE5.md part
 * B) on real Postgres, asserting the fixed behaviour: a withdrawn recovery
 * leaves the re-let asset tracked (the tenure ends only by this loan's own
 * dated records), and a purged event delivered again is refused, not new.
 * Every value is synthetic.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/breaker-r3.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { testSetup } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import type { LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import type { SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { prisma } from "@/lib/prisma"
import { pollTenant } from "./poll"
import { ingestEvent } from "./ingest"
import { loanCovering } from "./event-insert"
import { resolveAlert } from "./alerts"
import { purgeTelematicsPositions } from "./purge"
import { alertEvent, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { relet: "", releDevice: "", loan: "", device: "" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}

suite.sequential("telematics policy breaker, round 3 (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    ids.relet = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    ids.loan = await bookOperatingLease(database(), fx, setSession, fx.assets[2])
    ids.releDevice = await installDevice(fx, fx.assets[1], "SIM-STEADY-1", daysAgo(30))
    ids.device = await installDevice(fx, fx.assets[2], "SIM-STEADY-2", daysAgo(30))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("a re-let asset whose recovery is withdrawn (asset back with the lessee) is still tracked", async () => {
    // The asset was returned by an earlier lease and re-let from stock: RETURNED_TO_STOCK, dated before this lease began (booking keeps it).
    await testSetup(database(),
      [`UPDATE "FinancedAsset" SET "lessorStatus" = 'RETURNED_TO_STOCK', "lessorStatusAt" = (SELECT "startDate" FROM "Loan" WHERE "id" = $2) - INTERVAL '1 day' WHERE "id" = $1`, fx.assets[1], ids.relet],
      [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, ids.relet])
    expect(await loanCovering(prisma, fx.tenantId, fx.assets[1], new Date())).toBe(ids.relet)
    // A recovery opens (the asset RECOVERED), then is withdrawn: the asset goes back to the lessee, and the
    // recovery trigger restores the previous status RETURNED_TO_STOCK stamped CURRENT_TIMESTAMP (migration 20261015400000:1096).
    await testSetup(database(),
      [`INSERT INTO "Recovery" ("id", "tenantId", "loanId", "assetId", "route", "status", "recoveredOn", "location", "condition", "createdById", "previousLessorStatus", "updatedAt")
        VALUES ($1, $2, $3, $4, 'NON_NCA_COURT_ORDER', 'RECOVERED', CURRENT_DATE, 'Synthetic yard', 'Synthetic condition', $5, 'RETURNED_TO_STOCK', now())`,
      `rc3_${t}`, fx.tenantId, ids.relet, fx.assets[1], fx.adminA],
      [`UPDATE "FinancedAsset" SET "lessorStatus" = 'RECOVERED', "lessorStatusAt" = now() WHERE "id" = $1`, fx.assets[1]])
    // The withdrawal itself runs with every trigger on, so syncRecoveryAssetStatus does what it does in production.
    await database().$executeRawUnsafe(`UPDATE "Recovery" SET "status" = 'WITHDRAWN', "closedAt" = now(), "withdrawnReason" = 'Synthetic: paid up, asset returned to the lessee' WHERE "id" = $1`, `rc3_${t}`)
    const asset = await database().financedAsset.findUniqueOrThrow({ where: { id: fx.assets[1] }, select: { lessorStatus: true, lessorStatusAt: true } })
    expect(asset.lessorStatus).toBe("RETURNED_TO_STOCK")
    // The asset is back with the lessee and the loan still DEFAULTED: the loan covers it again.
    expect(await loanCovering(prisma, fx.tenantId, fx.assets[1], new Date())).toBe(ids.relet)
    const device = { id: ids.releDevice, tenantId: fx.tenantId, assetId: fx.assets[1], provider: "simulated" }
    const tamper = { ...alertEvent("SIM-STEADY-1", new Date(Date.now() + 1_000), "TAMPER"), providerEventId: `r3-tamper-${t}` }
    // A tamper on the defaulted lessee's asset is a work item on that loan, and the device is still polled.
    const raised = await prisma.$transaction((tx) => ingestEvent(tx, device, tamper, { now: new Date(), simulated: true, retentionDays: 90 }))
    expect(raised).toMatchObject({ stored: true })
    expect(await database().telematicsAlert.findUniqueOrThrow({ where: { id: (raised as { alertId: string }).alertId } })).toMatchObject({ loanId: ids.relet })
    const polled = await prisma.$queryRaw<{ id: string }[]>`SELECT "id" FROM "TrackerDevice" WHERE "id" = ${ids.releDevice}
      AND public."telematicsLoanAt"("tenantId", "assetId", (now() AT TIME ZONE 'UTC')) IS NOT NULL`
    expect(polled).toEqual([{ id: ids.releDevice }])
  }, 120_000)

  it("a purged repeat alert event, delivered again, is refused as older than retention: no fresh work item", async () => {
    const device = { id: ids.device, tenantId: fx.tenantId, assetId: fx.assets[2], provider: "simulated" }
    const ctx = () => ({ now: new Date(), simulated: true, retentionDays: 90 })
    const first = { ...alertEvent("SIM-STEADY-2", new Date(Date.now() - 3 * 86_400_000), "GEOFENCE_EXIT"), providerEventId: `r3-a1-${t}` }
    const repeat = { ...alertEvent("SIM-STEADY-2", new Date(Date.now() - 2 * 86_400_000), "GEOFENCE_EXIT"), providerEventId: `r3-a2-${t}` }
    const raised = await prisma.$transaction((tx) => ingestEvent(tx, device, first, ctx()))
    expect(await prisma.$transaction((tx) => ingestEvent(tx, device, repeat, ctx()))).toMatchObject({ stored: true, alertId: (raised as { alertId: string }).alertId })
    expect(await resolveAlert({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` }, (raised as { alertId: string }).alertId,
      { note: "Synthetic: checked with the lessee" })).toMatchObject({ kind: "ok" })
    // Retention 1 day: the nightly purge deletes the folded repeat (nothing refers to it); the first event stays (the alert refers to it).
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 1 } })
    await purgeTelematicsPositions()
    expect(await database().telematicsEvent.count({ where: { providerEventId: repeat.providerEventId } })).toBe(0)
    // The provider sends the two-day-old repeat again (an overlapping window, a cursor reset): it is older than the
    // tenant's retention, so the database refuses it as the event it is (a skip, not a retry), and no item opens.
    await expect(prisma.$transaction((tx) => ingestEvent(tx, device, repeat, { ...ctx(), retentionDays: 1 })))
      .rejects.toThrow(/database refused the event \(23514\): A telematics event older than the tenant's retention is not stored/)
    expect(await database().telematicsAlert.count({ where: { deviceId: ids.device, status: "OPEN" } })).toBe(0)
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { telematicsPositionRetentionDays: 90 } })
  }, 120_000)
})
