/**
 * Policy-breaker repros for PR #222 (docs/asset-finance/SLICE5.md part B) on
 * real Postgres, asserting the fixed behaviour: a loan's tenure of the asset
 * ends at the asset's recovery or the loan's closing, each purpose needs its
 * own grounds, and overlapping sweeps fold an alert. Every value is synthetic.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/breaker.integration.test.ts
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
import { revealPosition } from "./position-view"
import { registerTelematicsProvider } from "./registry"
import { registerTrackerDevice } from "./devices"
import { alertEvent, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loan: "", device: "", collector: "", otherDevice: "" }
const meta = { ipAddress: "192.0.2.10", userAgent: "telematics-breaker" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const as = (userId: string, role: string) => ({ tenantId: fx.tenantId, userId, userEmail: `${userId}@telematics-it.test`, role })

registerTelematicsProvider({
  id: "acme-gps", label: "Second provider (test double)", simulated: false,
  deviceIdError: () => null, assertUsable: () => undefined, poll: async () => ({ events: [], cursors: {}, simulated: false }),
})

suite.sequential("telematics policy breaker (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    ids.loan = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    await bookOperatingLease(database(), fx, setSession, fx.assets[2])
    await bookOperatingLease(database(), fx, setSession, fx.assets[3])
    ids.device = await installDevice(fx, fx.assets[1], "SIM-STEADY-1", daysAgo(30))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
    ids.collector = (await database().user.create({ data: { tenantId: fx.tenantId, email: `collector-${t}@staff.invalid`, password: "x", role: "COLLECTIONS_OFFICER" } })).id
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("operator and dealer roles never reach a position", async () => {
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, ids.loan])
    for (const role of ["OPERATOR_ADMIN", "OPERATOR_SUPPORT", "DEALER", "CLIENT", "READONLY", "INSURANCE_OFFICER"]) {
      expect(await revealPosition(as(ids.collector, role), ids.loan, { context: "DEFAULT" }, meta), role).toMatchObject({ kind: "refused", status: 403 })
    }
  }, 120_000)

  it("after the asset is recovered and sold, the old loan reveals nothing from after the recovery (its tenure ended)", async () => {
    // The loan defaulted; the asset was recovered 5 days ago and sold (recovery SOLD, shortfall still pursued, so "open").
    await testSetup(database(),
      [`INSERT INTO "Recovery" ("id", "tenantId", "loanId", "assetId", "route", "status", "recoveredOn", "location", "condition", "createdById", "updatedAt")
        VALUES ($1, $2, $3, $4, 'NON_NCA_COURT_ORDER', 'RECOVERED', CURRENT_DATE - 5, 'Synthetic yard', 'Synthetic condition', $5, now())`,
      `rc_${t}`, fx.tenantId, ids.loan, fx.assets[1], fx.adminA],
      [`UPDATE "Recovery" SET "status" = 'SOLD' WHERE "id" = $1`, `rc_${t}`])
    const recoveredOn = (await database().recovery.findUniqueOrThrow({ where: { id: `rc_${t}` } })).recoveredOn
    const stored = await database().telematicsPosition.findFirstOrThrow({ where: { deviceId: ids.device }, orderBy: { occurredAt: "desc" } })
    // The device's newest fix is from after the borrower lost the asset (a third party's, the buyer's, location): never shown.
    expect(stored.occurredAt.getTime()).toBeGreaterThan(recoveredOn.getTime() + 86_400_000)
    // The trail keeps the fixes from the loan's own tenure: the latest shown is from before the recovery, never after.
    const shown = await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "RECOVERY" }, meta)
    expect(shown).toMatchObject({ kind: "ok" })
    if ("position" in shown) expect(Date.parse(shown.position.occurredAt)).toBeLessThan(recoveredOn.getTime())
  }, 120_000)

  it("a completed (closed) loan with an open legal matter reveals nothing taken after it closed", async () => {
    await testSetup(database(),
      [`UPDATE "Recovery" SET "status" = 'WITHDRAWN', "closedAt" = now(), "withdrawnReason" = 'Synthetic withdrawal' WHERE "id" = $1`, `rc_${t}`],
      [`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() - INTERVAL '5 days' WHERE "id" = $1`, ids.loan],
      [`INSERT INTO "LegalMatter" ("id", "tenantId", "loanId", "createdById", "updatedAt") VALUES ($1, $2, $3, $4, now())`, `lm_${t}`, fx.tenantId, ids.loan, fx.adminA])
    const closedAt = (await database().loan.findUniqueOrThrow({ where: { id: ids.loan } })).closedAt as Date
    expect((await database().telematicsPosition.findFirstOrThrow({ where: { deviceId: ids.device }, orderBy: { occurredAt: "desc" } })).occurredAt > closedAt).toBe(true)
    const shown = await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "LEGAL_MATTER" }, meta)
    expect(shown).toMatchObject({ kind: "ok" })
    if ("position" in shown) expect(Date.parse(shown.position.occurredAt)).toBeLessThan(closedAt.getTime())
  }, 120_000)

  it("context RECOVERY is refused (409, no view logged) for a loan with no open recovery (only a legal matter)", async () => {
    const before = await database().telematicsPositionAccess.count({ where: { loanId: ids.loan } })
    expect(await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "RECOVERY" }, meta)).toMatchObject({ kind: "refused", status: 409 })
    expect(await database().telematicsPositionAccess.count({ where: { loanId: ids.loan } })).toBe(before)
    await testSetup(database(),
      [`UPDATE "LegalMatter" SET "status" = 'CLOSED', "closedAt" = now() WHERE "id" = $1`, `lm_${t}`],
      [`UPDATE "Loan" SET "status" = 'ACTIVE', "closedAt" = NULL WHERE "id" = $1`, ids.loan])
  }, 120_000)

  it("the same providerEventId under two providers is two events; a replay under either is a duplicate", async () => {
    const reg = await registerTrackerDevice({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` }, fx.assets[2],
      { provider: "acme-gps", externalDeviceId: "ACME-0001", installedOn: daysAgo(5) })
    expect(reg).toMatchObject({ kind: "ok" })
    ids.otherDevice = (reg as { id: string }).id
    const sim = { id: ids.device, tenantId: fx.tenantId, assetId: fx.assets[1], provider: "simulated" }
    const acme = { id: ids.otherDevice, tenantId: fx.tenantId, assetId: fx.assets[2], provider: "acme-gps" }
    const shared = `collide-${t}`
    const ev = (externalDeviceId: string) => ({ ...alertEvent(externalDeviceId, new Date(Date.now() - 60_000), "TAMPER"), providerEventId: shared })
    const ctx = { now: new Date(), simulated: false, retentionDays: 90 }
    const a = await prisma.$transaction((tx) => ingestEvent(tx, sim, ev("SIM-STEADY-1"), ctx))
    const b = await prisma.$transaction((tx) => ingestEvent(tx, acme, ev("ACME-0001"), ctx))
    expect(a).toMatchObject({ stored: true })
    expect(b).toMatchObject({ stored: true })
    expect(await prisma.$transaction((tx) => ingestEvent(tx, acme, ev("ACME-0001"), ctx))).toEqual({ stored: false })
    // A device cannot ingest under a provider it is not registered with.
    await expect(prisma.$transaction((tx) => ingestEvent(tx, { ...sim, provider: "acme-gps" }, { ...ev("SIM-STEADY-1"), providerEventId: `x-${t}` }, ctx)))
      .rejects.toThrow(/database refused the event \(23514\): A telematics event is of an active device of the tenant, under the device's provider/)
  }, 120_000)

  it("two overlapping sweeps raising different alert events of one kind on one device take turns on the device row: both succeed, one item", async () => {
    const acme = { id: ids.otherDevice, tenantId: fx.tenantId, assetId: fx.assets[2], provider: "acme-gps" }
    await testSetup(database(), [`UPDATE "TelematicsAlert" SET "status" = 'RESOLVED', "resolvedAt" = now(), "resolvedById" = $2, "resolutionNote" = 'Synthetic' WHERE "deviceId" = $1`, ids.otherDevice, fx.officer])
    const ctx = { now: new Date(), simulated: false, retentionDays: 90 }
    const one = () => prisma.$transaction(async (tx) => {
      const out = await ingestEvent(tx, acme, alertEvent("ACME-0001", new Date(Date.now() - 30_000), "POWER_CUT"), ctx)
      await new Promise((r) => setTimeout(r, 300))
      return out
    })
    const results = await Promise.allSettled([one(), one()])
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled"])
    expect(await database().telematicsAlert.findMany({ where: { deviceId: ids.otherDevice, kind: "POWER_CUT", status: { not: "RESOLVED" } }, select: { occurrences: true } }))
      .toEqual([{ occurrences: 2 }])
  }, 120_000)

  it("no outbound row (Message, Notification, EmailLog) comes from polling alerts", async () => {
    const counts = async () => Promise.all([
      database().message.count({ where: { tenantId: fx.tenantId } }),
      database().notification.count({ where: { tenantId: fx.tenantId } }),
      database().emailLog.count({ where: { tenantId: fx.tenantId } }),
    ])
    const before = await counts()
    const tamper = await installDevice(fx, fx.assets[3], "SIM-TAMPER-7", daysAgo(30))
    await pollTenant(fx.tenantId, new Date())
    expect(await counts()).toEqual(before)
    expect(await database().telematicsAlert.count({ where: { deviceId: tamper } })).toBeGreaterThan(0)
  }, 120_000)
})
