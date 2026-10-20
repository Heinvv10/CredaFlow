/**
 * A live tracker heartbeat is shown beside the payout checklist's tracker
 * item but never completes it (docs/asset-finance/SLICE5.md part B): the
 * TRACKER_CONFIRMED item still needs a staff-uploaded TRACKER_CERTIFICATE, in
 * the route and in the database.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/telematics/tracker-certificate.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { ruleRefuses } from "@/lib/asset-finance/lease-servicing.integration-fixture"
import { approveLease, leaseBody, signLease, type LeaseFixture } from "@/lib/asset-finance/lease.integration-fixture"
import { bookingRoutes, type SessionUser } from "@/lib/asset-finance/payout-booking.integration-fixture"
import { pollTenant } from "./poll"
import { trackerHeartbeat } from "./devices"
import { cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice } from "./telematics.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
let dealId = ""
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const staff = (id: string, role: "LOAN_ADMIN" | "CREDIT_OFFICER") => setSession({ id, email: `${id}@telematics-it.test`, role, tenantId: fx.tenantId })
const confirmDirect = (evidenceDocumentId: string | null) => (tx: Tx) => tx.payoutChecklistItem.update({
  where: { dealId_item: { dealId, item: "TRACKER_CONFIRMED" } }, data: { confirmedById: fx.officer, confirmedAt: new Date(), evidenceDocumentId },
})

suite.sequential("a tracker heartbeat does not replace the tracker certificate (real DB)", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"
    fx = await createTelematicsFixture(database(), t)
    dealId = await approveLease(fx, staff, leaseBody(fx, { assetId: fx.assets[1], contractType: "OPERATING_LEASE", rentalTiming: "ARREARS", entityId: fx.evidenced }))
    await signLease(fx, database(), setSession, dealId)
    await installDevice(fx, fx.assets[1], "SIM-STEADY-1", daysAgo(2))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("shows the live heartbeat, labelled simulated", async () => {
    const heartbeat = await trackerHeartbeat(fx.tenantId, fx.assets[1])
    const newest = await database().telematicsEvent.findFirstOrThrow({ where: { tenantId: fx.tenantId }, orderBy: { occurredAt: "desc" } })
    expect(heartbeat).toMatchObject({ provider: "simulated", simulated: true, lastSeenAt: newest.occurredAt, matchesTrackerId: false })
  }, 120_000)

  it("refuses to confirm the tracker item without a certificate, in the route (422) and in the database", async () => {
    staff(fx.officer, "CREDIT_OFFICER")
    const confirmed = await bookingRoutes(fx.host).confirm(dealId, "TRACKER_CONFIRMED", { evidenceDocumentId: null, attestedSerial: null, note: "Live heartbeat seen" })
    expect(confirmed.status, await confirmed.clone().text()).toBe(422)
    expect(await confirmed.json()).toMatchObject({ error: "Choose the evidence document" })
    await ruleRefuses(database(), { table: "PayoutChecklistItem", constraint: "PayoutChecklistItem_evidence_required" }, /PayoutChecklistItem_evidence_required/, confirmDirect(null))
    const notACertificate = (await database().entityDocument.create({ data: {
      tenantId: fx.tenantId, entityId: fx.evidenced, dealId, docType: "OTHER", fileName: "heartbeat.pdf", mimeType: "application/pdf", fileSize: 1,
      storagePath: `/nonexistent/${dealId}-heartbeat.pdf`, contentSha256: "0".repeat(64), uploadedByType: "staff", uploadedById: fx.officer,
    } })).id
    await ruleRefuses(database(), { table: "PayoutChecklistItem", trigger: "PayoutChecklistItem_guard" }, /evidence must be a live staff upload on this deal of type TRACKER_CERTIFICATE/,
      confirmDirect(notACertificate))
    const item = await database().payoutChecklistItem.findUniqueOrThrow({ where: { dealId_item: { dealId, item: "TRACKER_CONFIRMED" } } })
    expect(item.confirmedById).toBeNull()
  }, 120_000)
})
