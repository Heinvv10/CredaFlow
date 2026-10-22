/**
 * Edge-case probes for part T (meter-reading void, tracker closure) on real
 * Postgres. Synthetic data only. Fakes only the provider transport.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 TENANT_RLS=on DATABASE_URL=postgresql://... \
 *     npx vitest run --no-file-parallelism lib/asset-finance/edge-followups.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { unlink } from "node:fs/promises"
import type { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { POST as voidRoute } from "@/app/api/asset-finance/leases/[loanId]/readings/[readingId]/void/route"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { dispatch } from "@/lib/messaging/providers"
import { _resetRateLimitStore } from "@/lib/rate-limit"
import { removeTrackerDevice } from "@/lib/telematics/devices"
import { addAsset, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, loanStartDate, telematicsTestClient, today } from "@/lib/telematics/telematics.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import type { LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { recordMeterReading } from "./meter-readings"
import { decideMeterReadingVoid, requestMeterReadingVoid } from "./meter-void"
import { invoiceEndOfTerm } from "./lease-end-invoice"
import { processTrackerClosures } from "./tracker-closure"
import type { SigningTx } from "./signing-prepare"
import type { LeaseActionResult } from "./lease-route"
import { sastCalendarDate as sastDay } from "@/lib/date/sast"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
vi.mock("@/lib/messaging/providers", async (original) => ({ ...(await original<typeof import("@/lib/messaging/providers")>()), dispatch: vi.fn() }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const letters: string[] = []

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const actor = (userId: string) => ({ tenantId: fx.tenantId, userId, userEmail: `${userId}@void-edge.test` })
const officerActor = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@closure-edge.test` })
const inTx = <T,>(fn: (tx: SigningTx) => Promise<T>) => database().$transaction((tx) => fn(tx as unknown as SigningTx))
type Reasoned = LeaseActionResult & { voidId?: string; readingId?: string }
const request = (loanId: string, userId: string, readingId: string, reason: unknown = "Typed the wrong digits: a slip of the keyboard") =>
  inTx<Reasoned>((tx) => requestMeterReadingVoid(tx, actor(userId), { loanId, readingId, reason }))
const decide = (loanId: string, userId: string, voidId: string, decision: "APPROVE" | "REJECT") =>
  inTx((tx) => decideMeterReadingVoid(tx, actor(userId), { loanId, voidId, decision }))
const record = (loanId: string, readingDate: string, value: number) =>
  inTx((tx) => recordMeterReading(tx, actor(fx.officer), { loanId, readingDate, value, evidenceDocumentId: null, today: today() }))
/** Request by the officer, approve by adminA. */
async function voidReading(loanId: string, readingId: string): Promise<string> {
  const asked = await request(loanId, fx.officer, readingId)
  expect(asked).toMatchObject({ kind: "requested" })
  const voidId = (asked as { voidId: string }).voidId
  expect(await decide(loanId, fx.adminA, voidId, "APPROVE")).toEqual({ kind: "decided", status: "APPROVED" })
  return voidId
}
const startReadingOf = async (loanId: string) => (await database().assetMeterReading.findFirstOrThrow({ where: { loanId }, orderBy: { readingDate: "asc" } })).id
async function newLease(daysBack = 30): Promise<{ loanId: string; assetId: string }> {
  _resetRateLimitStore()
  const assetId = await addAsset(database(), fx)
  return { loanId: await bookOperatingLease(database(), fx, setSession, assetId, daysBack), assetId }
}

suite.sequential("part T edge probes: meter-reading void and tracker closure (real DB)", () => {
  beforeAll(async () => {
    fx = await createTelematicsFixture(database(), t)
    // The synthetic lender's wording approved (test setup): closures are held until it is.
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { assetFinanceLegalWordingApproved: true } })
  }, 600_000)

  afterAll(async () => {
    const stored = await db?.trackerClosure.findMany({ where: { tenantId: fx?.tenantId }, select: { letterStoragePath: true } })
    await Promise.all([...letters, ...(stored ?? []).map((s) => s.letterStoragePath)].filter((p): p is string => !!p).map((p) => unlink(p).catch(() => undefined)))
    await db?.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.notificationLog.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.message.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.conversation.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.contactConsent.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.contactIdentity.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.contact.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.emailConfig.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.messageTemplate.deleteMany({ where: { tenantId: fx?.tenantId } }),
    ]).catch(() => undefined)
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 120_000)

  // ------------------------------------------------------------------ voids

  it("void the start reading, then record a reading BELOW it: admitted (the voided value is no floor) and becomes the new start", async () => {
    const { loanId } = await newLease()
    const start = await startReadingOf(loanId)
    // A later reading first: the lease's only live reading is never voided.
    expect(await record(loanId, daysAgo(10), 1_010)).toMatchObject({ kind: "recorded" })
    await voidReading(loanId, start)
    expect(await record(loanId, daysAgo(20), 900)).toMatchObject({ kind: "recorded" })
    expect(await record(loanId, daysAgo(2), 1_020)).toMatchObject({ kind: "recorded" })
    expect(await record(loanId, today(), 1_015)).toMatchObject({ kind: "refused", reason: "not_monotonic" })
  }, 900_000)

  it("the lease's ONLY reading is never voided, so a portal reading still meets the pace ceiling (an absurd reading is refused)", async () => {
    const { loanId } = await newLease()
    expect(await request(loanId, fx.officer, await startReadingOf(loanId))).toMatchObject({ kind: "refused", reason: "void_refused", error: expect.stringContaining("only reading") })
    const absurd = await inTx((tx) => recordMeterReading(tx, { tenantId: fx.tenantId, clientId: fx.director }, { loanId, readingDate: today(), value: 9_999_999, evidenceDocumentId: null, today: today() }))
    // Before the void the same reading is refused as implausible; with no live start reading nothing bounds it.
    expect(absurd).toMatchObject({ kind: "refused", reason: "implausible_reading" })
  }, 900_000)

  it("void the start, then the end of term is invoiced: never measured from the final reading itself (fails closed), and a corrected start bills as before", async () => {
    type Mode = "control" | "voided" | "corrected"
    const billed = async (mode: Mode): Promise<{ kind: string; reason?: string; total: number | null }> => {
      const { loanId } = await newLease(30)
      const start = await startReadingOf(loanId)
      const final = await record(loanId, today(), 6_000)
      expect(final).toMatchObject({ kind: "recorded" })
      if (mode !== "control") await voidReading(loanId, start)
      if (mode === "corrected") {
        const startOn = sastDay((await database().loan.findUniqueOrThrow({ where: { id: loanId } })).startDate)
        expect(await record(loanId, startOn, 1_000)).toMatchObject({ kind: "recorded" })
      }
      await testSetup(database(),
        [`UPDATE "LeaseRental" SET "rentalExclVatCents" = 0, "maintenanceExclVatCents" = 0, "vatCents" = 0, "totalCents" = 0 WHERE "loanId" = $1`, loanId],
        [`INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "status", "inspectedOn", "inspectedById", "inspectionCondition", "finalReadingId", "updatedAt")
          VALUES ($1, $2, $3, 'EXPIRY', 'RETURN', 'INSPECTED', CURRENT_DATE, $4, 'Synthetic: returned', $5, now())`, `eot_${randomUUID()}`, fx.tenantId, loanId, fx.adminB, (final as { readingId: string }).readingId])
      const result = await inTx((tx) => invoiceEndOfTerm(tx, { tenantId: fx.tenantId, userId: fx.officer }, { loanId, today: today() })).catch((e: unknown) => { throw e })
      const invoiced = await database().leaseEndOfTerm.findFirstOrThrow({ where: { loanId } })
      const total = invoiced.taxInvoiceId ? (await database().taxInvoice.findFirstOrThrow({ where: { loanId }, orderBy: { createdAt: "desc" } })).totalInclVatCents : null
      return { kind: result.kind, reason: (result as { reason?: string }).reason, total }
    }
    const control = await billed("control")
    expect(control.total).not.toBeNull()
    // With only the final reading live there is no start: refused, nothing billed (never zero usage from the final itself).
    expect(await billed("voided")).toMatchObject({ kind: "refused", reason: "start_reading", total: null })
    expect((await billed("corrected")).total).toBe(control.total)
  }, 1_200_000)

  it("a void requested, then the reading becomes a final reading before approval: the approval is refused (TS and SQL); the request can still be rejected", async () => {
    const { loanId } = await newLease()
    const reading = (await record(loanId, daysAgo(3), 1_050)) as { readingId: string }
    const asked = (await request(loanId, fx.officer, reading.readingId)) as { voidId: string }
    await testSetup(database(), [`INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "finalReadingId", "updatedAt") VALUES ($1, $2, $3, 'EXPIRY', 'RETURN', $4, now())`,
      `eot_${randomUUID()}`, fx.tenantId, loanId, reading.readingId])
    expect(await decide(loanId, fx.adminA, asked.voidId, "APPROVE")).toMatchObject({ kind: "refused", reason: "void_refused" })
    await expect(database().$executeRawUnsafe(`UPDATE "AssetMeterReadingVoid" SET "status" = 'APPROVED', "decidedById" = $2, "decidedAt" = now() WHERE "id" = $1`, asked.voidId, fx.adminA))
      .rejects.toThrow(/final reading of an end of term/)
    expect((await database().assetMeterReading.findUniqueOrThrow({ where: { id: reading.readingId } })).voidedAt).toBeNull()
    expect(await decide(loanId, fx.adminA, asked.voidId, "REJECT")).toEqual({ kind: "decided", status: "REJECTED" })
  }, 900_000)

  it("two void requests for the same reading at once, through the route: one 200, the other a clean 409 (not a 500 / thrown unique violation)", async () => {
    const { loanId } = await newLease()
    const reading = (await record(loanId, daysAgo(3), 1_050)) as { readingId: string }
    setSession({ id: fx.officer, email: `${fx.officer}@void-edge.test`, role: "LOAN_ADMIN", tenantId: fx.tenantId })
    const post = () => voidRoute(
      new NextRequest(`http://${fx.host}/api/asset-finance/leases/${loanId}/readings/${reading.readingId}/void`, {
        method: "POST", headers: { host: fx.host, "content-type": "application/json" }, body: JSON.stringify({ reason: "Typed the wrong digits: a slip of the keyboard" }),
      }), { params: Promise.resolve({ loanId, readingId: reading.readingId }) })
    const results = await Promise.allSettled([post(), post()])
    expect(results.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.message)).toEqual([])
    expect(results.map((r) => (r as PromiseFulfilledResult<Response>).value.status).sort()).toEqual([200, 409])
    expect(await database().assetMeterReadingVoid.count({ where: { readingId: reading.readingId, status: "PENDING" } })).toBe(1)
  }, 900_000)

  it("two approvals of one void at once, and an approval against a rejection at once: exactly one decides, the other is refused cleanly", async () => {
    const { loanId } = await newLease()
    const a = (await record(loanId, daysAgo(3), 1_050)) as { readingId: string }
    const askedA = (await request(loanId, fx.officer, a.readingId)) as { voidId: string }
    const approvals = await Promise.allSettled([decide(loanId, fx.adminA, askedA.voidId, "APPROVE"), decide(loanId, fx.adminB, askedA.voidId, "APPROVE")])
    expect(approvals.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.message)).toEqual([])
    expect(approvals.map((r) => (r as PromiseFulfilledResult<{ kind: string }>).value.kind).sort()).toEqual(["decided", "refused"])
    const b = (await record(loanId, daysAgo(2), 1_060)) as { readingId: string }
    const askedB = (await request(loanId, fx.officer, b.readingId)) as { voidId: string }
    const mixed = await Promise.allSettled([decide(loanId, fx.adminA, askedB.voidId, "APPROVE"), decide(loanId, fx.adminB, askedB.voidId, "REJECT")])
    expect(mixed.filter((r) => r.status === "rejected").map((r) => (r as PromiseRejectedResult).reason?.message)).toEqual([])
    const row = await database().assetMeterReadingVoid.findUniqueOrThrow({ where: { id: askedB.voidId } })
    const reading = await database().assetMeterReading.findUniqueOrThrow({ where: { id: b.readingId } })
    // The void's decision and the reading's stamp agree.
    expect(reading.voidedAt !== null).toBe(row.status === "APPROVED")
    // The audit trail holds one decision for it.
    expect(await database().auditLog.count({ where: { tenantId: fx.tenantId, entityId: b.readingId, action: { in: ["METER_READING_VOID_APPROVED", "METER_READING_VOID_REJECTED"] } } })).toBe(1)
  }, 900_000)

  // ---------------------------------------------------------------- closure

  /** A lease with a simulated device, completed by SQL (the database opens the closure). */
  async function completedLease(label: string): Promise<{ loanId: string; assetId: string; deviceId: string }> {
    const { loanId, assetId } = await newLease()
    const deviceId = await installDevice(fx, assetId, label, await loanStartDate(database(), loanId))
    await database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() WHERE "id" = $1`, loanId)
    return { loanId, assetId, deviceId }
  }
  const closures = (loanId: string) => database().trackerClosure.findMany({ where: { tenantId: fx.tenantId, loanId }, orderBy: { createdAt: "asc" } })
  const run = (send?: Parameters<typeof processTrackerClosures>[1]) => withoutTenantScope(() => processTrackerClosures(fx.tenantId, send))
  const noSend: Parameters<typeof processTrackerClosures>[1] = async () => { throw new Error("no send expected") }

  it("a loan that completes, is reopened, and has its closure processed while open again: the borrower is not told tracking stopped", async () => {
    const { loanId } = await completedLease("SIM-STEADY-1")
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'ACTIVE', "closedAt" = NULL WHERE "id" = $1`, loanId])
    const sends: unknown[] = []
    await run(async (args) => { sends.push(args); throw new Error("stop") })
    const [closure] = await closures(loanId)
    expect(sends).toHaveLength(0)
    expect(closure.noticeLoggedAt).toBeNull()
    expect(await database().notificationLog.count({ where: { tenantId: fx.tenantId, loanId, event: "tracking_stopped" } })).toBe(0)
    expect(closure.letterStoragePath).toBeNull()
  }, 900_000)

  it("completes, is processed and the device removed, is reopened, gets a NEW device and completes again: a second closure for the new device only; the first is untouched", async () => {
    const { loanId, assetId, deviceId } = await completedLease("SIM-STEADY-2")
    await run(noSend)
    expect(await removeTrackerDevice(officerActor(), deviceId, {})).toEqual({ kind: "ok" })
    const [first] = await closures(loanId)
    expect(first).toMatchObject({ deviceId, removedById: fx.officer })
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'ACTIVE', "closedAt" = NULL WHERE "id" = $1`, loanId])
    const second = await installDevice(fx, assetId, "SIM-STEADY-3", today())
    await database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() WHERE "id" = $1`, loanId)
    const all = await closures(loanId)
    expect(all.map((c) => c.deviceId)).toEqual([deviceId, second])
    expect(await database().trackerClosure.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ noticeLoggedAt: first.noticeLoggedAt, letterSha256: first.letterSha256, removedAt: first.removedAt })
  }, 900_000)

  it("a second live device on one asset is refused at registration, so one asset never gets two closures for the same loan", async () => {
    const { loanId, assetId } = await completedLease("SIM-STEADY-4")
    const extra = await (await import("@/lib/telematics/devices")).registerTrackerDevice({ ...officerActor() }, assetId, { provider: "simulated", externalDeviceId: "SIM-STEADY-5", installedOn: today() })
    expect(extra).toMatchObject({ kind: "refused", status: 409 })
    expect(await closures(loanId)).toHaveLength(1)
  }, 900_000)

  it("an entity borrower with no acting person: the notice is recorded with no recipient, the email BLOCKED (nothing sent), the letter stored in the entity's name, no failure", async () => {
    const { loanId } = await completedLease("SIM-STEADY-6")
    const relationships = await database().entityRelationship.findMany({ where: { tenantId: fx.tenantId, entityId: fx.evidenced, active: true }, select: { id: true } })
    try {
      await testSetup(database(), [`UPDATE "EntityRelationship" SET "active" = false WHERE "tenantId" = $1 AND "entityId" = $2`, fx.tenantId, fx.evidenced])
      vi.mocked(dispatch).mockClear()
      const result = await run(noSend)
      expect(result.failed).toBe(0)
      const mine = (await closures(loanId))[0]
      expect(mine).toMatchObject({ messageOutcome: "BLOCKED", messageNote: expect.stringContaining("No recipient with trusted contact details"), letterSha256: expect.any(String) })
      expect(mine.noticeLoggedAt).not.toBeNull()
      expect(await database().notificationLog.count({ where: { tenantId: fx.tenantId, loanId, event: "tracking_stopped" } })).toBe(0)
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      await testSetup(database(), [`UPDATE "EntityRelationship" SET "active" = true WHERE "id" = ANY($1::text[])`, relationships.map((r) => r.id)])
    }
  }, 900_000)

  it("the lender identity incomplete: the closure fails closed (nothing sent, nothing recorded, no letter), is counted failed, and completes once the identity is back", async () => {
    const { loanId } = await completedLease("SIM-STEADY-7")
    const config = await database().tenantConfig.findUniqueOrThrow({ where: { tenantId: fx.tenantId }, select: { ncrNumber: true } })
    expect(config.ncrNumber).not.toBeNull()
    try {
      await testSetup(database(), [`UPDATE "TenantConfig" SET "ncrNumber" = NULL WHERE "tenantId" = $1`, fx.tenantId])
      vi.mocked(dispatch).mockClear()
      const broken = await run(noSend)
      expect(broken.failed).toBeGreaterThanOrEqual(1)
      expect(await closures(loanId)).toMatchObject([{ noticeLoggedAt: null, messageOutcome: null, letterStoragePath: null }])
      expect(dispatch).not.toHaveBeenCalled()
    } finally {
      await testSetup(database(), [`UPDATE "TenantConfig" SET "ncrNumber" = $2 WHERE "tenantId" = $1`, fx.tenantId, config.ncrNumber])
    }
    const fixed = await run()
    expect(fixed.failed).toBe(0)
    expect((await closures(loanId))[0]).toMatchObject({ messageOutcome: "BLOCKED", letterSha256: expect.any(String) })
  }, 900_000)

  describe("with the lender's email set up", () => {
    let directorEmail = ""
    beforeAll(async () => {
      const director = await database().client.findUniqueOrThrow({ where: { id: fx.director } })
      directorEmail = director.email.toLowerCase()
      const contact = await database().contact.create({ data: { tenantId: fx.tenantId, clientId: director.id, status: "CLIENT", firstSeenChannel: "MANUAL", firstSeenContext: "synthetic-closure-edge" } })
      await database().contactIdentity.create({ data: { tenantId: fx.tenantId, contactId: contact.id, channel: "EMAIL", source: "MANUAL", value: directorEmail } })
      await database().emailConfig.create({ data: { tenantId: fx.tenantId, provider: "IMAP_SMTP", fromName: "Synthetic lender", fromAddress: "sender@synthetic.invalid", smtpHost: "smtp.synthetic.invalid", smtpUser: "synthetic", smtpPass: "synthetic", active: true } })
      vi.mocked(dispatch).mockImplementation(async () => ({ providerMessageId: `synthetic-edge-${randomUUID()}`, acceptedAt: new Date() }))
    })

    it("four runs at once over two closures, with a device removed meanwhile: one email per closure, one notice, one letter, nothing failed", async () => {
      const one = await completedLease("SIM-STEADY-8")
      const two = await completedLease("SIM-STEADY-9")
      vi.mocked(dispatch).mockClear()
      const runs = await Promise.all([run(), run(), removeTrackerDevice(officerActor(), one.deviceId, {}), run(), run()])
      expect(runs.filter((r) => "failed" in r).reduce((n, r) => n + (r as { failed: number }).failed, 0)).toBe(0)
      await run()
      await run()
      for (const { loanId } of [one, two]) {
        const [c] = await closures(loanId)
        expect(c).toMatchObject({ messageOutcome: "SENT", letterSha256: expect.any(String) })
        expect(c.noticeLoggedAt).not.toBeNull()
        expect(await database().notificationLog.count({ where: { tenantId: fx.tenantId, loanId, event: "tracking_stopped" } })).toBe(1)
      }
      expect(dispatch).toHaveBeenCalledTimes(2)
      expect((await closures(one.loanId))[0].removedAt).not.toBeNull()
    }, 900_000)

    it("a borrower who opted out of email: the email is BLOCKED (not sent), the notice and letter still happen, and the note says why", async () => {
      const { loanId } = await completedLease("SIM-STEADY-10")
      const contact = await database().contactIdentity.findFirstOrThrow({ where: { tenantId: fx.tenantId, channel: "EMAIL", value: directorEmail } })
      await database().contactConsent.create({ data: { tenantId: fx.tenantId, contactId: contact.contactId, channel: "EMAIL", purpose: "SERVICE_COMMS", status: "REVOKED", source: "MANUAL" } })
      vi.mocked(dispatch).mockClear()
      try {
        expect((await run()).failed).toBe(0)
      } finally {
        await testSetup(database(), [`DELETE FROM "ContactConsent" WHERE "contactId" = $1`, contact.contactId])
      }
      expect(dispatch).not.toHaveBeenCalled()
      const [c] = await closures(loanId)
      expect(c).toMatchObject({ messageOutcome: "BLOCKED", letterSha256: expect.any(String) })
      expect(c.messageNote).toMatch(/OPT/i)
      expect(c.noticeLoggedAt).not.toBeNull()
    }, 900_000)
  })
})
