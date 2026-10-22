/**
 * Round-2 policy-breaker repros for PR #222 (docs/asset-finance/SLICE5.md part
 * B) on real Postgres, asserting the fixed behaviour: the tenure ends when the
 * asset leaves the lessee (its lessor status), and whether an event is
 * simulated is the registered provider's definition. Every value is synthetic.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/breaker-r2.integration.test.ts
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
import type { NormalisedTelematicsEvent } from "./types"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loan: "", device: "", collector: "", loanB: "" }
const meta = { ipAddress: "192.0.2.10", userAgent: "telematics-breaker-r2" }

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const as = (userId: string, role: string) => ({ tenantId: fx.tenantId, userId, userEmail: `${userId}@telematics-it.test`, role })

/** A real (non-simulated) provider double whose poll answer claims `simulated: true`. */
const pending: NormalisedTelematicsEvent[] = []
registerTelematicsProvider({
  id: "acme-real", label: "Real provider (test double)", simulated: false,
  deviceIdError: () => null, assertUsable: () => undefined,
  poll: async () => ({ events: pending.splice(0), cursors: {}, simulated: true }),
})

suite.sequential("telematics policy breaker, round 2 (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    ids.loan = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    ids.loanB = await bookOperatingLease(database(), fx, setSession, fx.assets[2])
    ids.device = await installDevice(fx, fx.assets[1], "SIM-STEADY-1", daysAgo(30))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
    ids.collector = (await database().user.create({ data: { tenantId: fx.tenantId, email: `collector-${t}@staff.invalid`, password: "x", role: "COLLECTIONS_OFFICER" } })).id
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("an asset returned to the lessor's stock (end-of-term invoice unpaid, loan DEFAULTED) is no longer tracked under the ex-lessee's loan", async () => {
    // The lessee returned the asset 5 days ago (RETURNED_TO_STOCK); the end-of-term invoice is unpaid, so the loan is still open and now in default.
    // The return is dated by the loan's own end of term (inspected 5 days ago), not by the asset's status stamp.
    await testSetup(database(),
      [`UPDATE "FinancedAsset" SET "lessorStatus" = 'RETURNED_TO_STOCK', "lessorStatusAt" = now() - INTERVAL '5 days' WHERE "id" = $1`, fx.assets[1]],
      [`INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "status", "inspectedOn", "inspectedById", "inspectionCondition", "updatedAt")
        VALUES (gen_random_uuid()::text, $1, $2, 'EXPIRY', 'RETURN', 'INSPECTED', CURRENT_DATE - 5, $3, 'Synthetic: returned in fair condition', now())`, fx.tenantId, ids.loan, fx.officer],
      [`UPDATE "Loan" SET "status" = 'DEFAULTED' WHERE "id" = $1`, ids.loan])
    const device = { id: ids.device, tenantId: fx.tenantId, assetId: fx.assets[1], provider: "simulated" }
    const ctx = { now: new Date(), simulated: true, retentionDays: 90 }
    const at = new Date(Date.now() - 60_000)
    const position: NormalisedTelematicsEvent = {
      providerEventId: `r2-pos-${t}`, externalDeviceId: "SIM-STEADY-1", occurredAt: at, kind: "POSITION", position: { latitude: -26.1, longitude: 28.1, accuracyM: 5 },
    }
    // No agreement covers the lessor's own stock: the position and the tamper are not kept, no work item lands on the ex-lessee's loan.
    expect(await prisma.$transaction((tx) => ingestEvent(tx, device, position, ctx))).toEqual({ stored: false, noAgreement: true })
    const alert = await prisma.$transaction((tx) => ingestEvent(tx, device, { ...alertEvent("SIM-STEADY-1", at, "TAMPER"), providerEventId: `r2-tamper-${t}` }, ctx))
    expect(alert).toEqual({ stored: false, noAgreement: true })
    expect(await database().telematicsAlert.count({ where: { loanId: ids.loan } })).toBe(0)
    // The view's tenure ends at the return too: nothing the device reported after it is shown (the trail keeps
    // what came before the return, and the latest shown is from before it).
    const shown = await revealPosition(as(ids.collector, "COLLECTIONS_OFFICER"), ids.loan, { context: "DEFAULT" }, meta)
    expect(shown).toMatchObject({ kind: "ok" })
    const returnedOn = Date.now() - 5 * 86_400_000
    if ("position" in shown) expect(Date.parse(shown.position.occurredAt)).toBeLessThan(returnedOn)
    // And the device is no longer polled.
    expect((await pollTenant(fx.tenantId, new Date())).devices).toBe(0)
  }, 120_000)

  it("a non-simulated provider whose poll answer says simulated:true is still a real device: its unverified meter feeds nothing", async () => {
    const reg = await registerTrackerDevice({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@telematics-it.test` }, fx.assets[2],
      { provider: "acme-real", externalDeviceId: "ACME-REAL-1", installedOn: daysAgo(5) })
    expect(reg).toMatchObject({ kind: "ok" })
    const deviceId = (reg as { id: string }).id
    expect((await database().trackerDevice.findUniqueOrThrow({ where: { id: deviceId } })).meterVerifiedAt).toBeNull()
    const last = await database().assetMeterReading.findFirstOrThrow({ where: { loanId: ids.loanB }, orderBy: [{ readingDate: "desc" }, { value: "desc" }] })
    pending.push({ providerEventId: `r2-meter-${t}`, externalDeviceId: "ACME-REAL-1", occurredAt: new Date(Date.now() - 60_000), kind: "METER", meter: { value: last.value + 5, unit: "HOURS" } })
    const run = await pollTenant(fx.tenantId, new Date())
    expect(run.failed).toBe(0)
    const event = await database().telematicsEvent.findFirstOrThrow({ where: { providerEventId: `r2-meter-${t}` } })
    expect(event).toMatchObject({ simulated: false, meterOutcome: "METER_UNVERIFIED" })
  }, 120_000)
})
