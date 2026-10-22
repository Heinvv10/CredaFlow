/**
 * Closing a tracked loan on real Postgres (docs/asset-finance/
 * SLICE5-FOLLOWUPS.md part T): whichever way a loan completes (a payment, an
 * end of term settled, any other status change) the database opens one
 * TrackerClosure per active device, once; none for a removed device. The
 * processor logs the portal notice, decides the email once through the real
 * sendMessage (blocked when the lender has no email set up or the borrower no
 * contact; only the provider dispatch is faked, and it is called once), and
 * stores the letter once; the device's removal closes the task. Each step is
 * the database's to record once.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/tracker-closure.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { unlink } from "node:fs/promises"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { dispatch } from "@/lib/messaging/providers"
import { readFile } from "@/lib/storage"
import { _resetRateLimitStore } from "@/lib/rate-limit"
import { removeTrackerDevice } from "@/lib/telematics/devices"
import { addAsset, bookInstalmentSale, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, installDevice, loanStartDate, telematicsTestClient } from "@/lib/telematics/telematics.integration-fixture"
import { payAllOwed, ruleRefuses, testSetup } from "./lease-servicing.integration-fixture"
import type { LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { completeEndOfTermIfSettled } from "./lease-end-invoice"
import { MessageDispatchConflictError } from "@/lib/messaging/dispatch-control"
import { MESSAGE_CLAIM_STALE_MS, processTrackerClosures, TRACKING_STOPPED_EVENT } from "./tracker-closure"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))
// Only the provider transport is faked: nothing leaves this machine.
vi.mock("@/lib/messaging/providers", async (original) => ({ ...(await original<typeof import("@/lib/messaging/providers")>()), dispatch: vi.fn() }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const loans = { paid: "", lease: "", other: "", removed: "" }
const devices = { paid: "", lease: "", other: "", removed: "" }
const letters: string[] = []

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const closuresOf = (loanId: string) => database().trackerClosure.findMany({ where: { tenantId: fx.tenantId, loanId } })
const officer = () => ({ tenantId: fx.tenantId, userId: fx.officer, userEmail: `${fx.officer}@closure-it.test` })
const process_ = () => withoutTenantScope(() => processTrackerClosures(fx.tenantId))

suite.sequential("tracker closure: once per completed loan and device, notices once, no real send (real DB)", () => {
  beforeAll(async () => {
    fx = await createTelematicsFixture(database(), t)
    // No message templates: a lender that predates the closure's gets it on its first closure.
    loans.paid = await bookInstalmentSale(database(), fx, setSession, fx.assets[1])
    devices.paid = await installDevice(fx, fx.assets[1], "SIM-STEADY-1", await loanStartDate(database(), loans.paid))
    for (const [n, key] of (["lease", "other", "removed"] as const).entries()) {
      const assetId = await addAsset(database(), fx)
      loans[key] = await bookOperatingLease(database(), fx, setSession, assetId)
      devices[key] = await installDevice(fx, assetId, `SIM-STEADY-${n + 2}`, await loanStartDate(database(), loans[key]))
    }
  }, 900_000)

  afterAll(async () => {
    const stored = await db?.trackerClosure.findMany({ where: { tenantId: fx?.tenantId }, select: { letterStoragePath: true } })
    await Promise.all([...letters, ...(stored ?? []).map((s) => s.letterStoragePath)].filter((p): p is string => !!p).map((p) => unlink(p).catch(() => undefined)))
    await db?.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.notificationLog.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.message.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.conversation.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.contactIdentity.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.contact.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.emailConfig.deleteMany({ where: { tenantId: fx?.tenantId } }),
      db.messageTemplate.deleteMany({ where: { tenantId: fx?.tenantId } }),
    ]).catch(() => undefined)
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 120_000)

  it("a loan settled by payment opens one closure for its active device", async () => {
    expect(await payAllOwed(database(), fx, loans.paid)).toBeGreaterThan(0)
    expect(await database().loan.findUniqueOrThrow({ where: { id: loans.paid }, select: { status: true } })).toEqual({ status: "COMPLETED" })
    const [closure, ...more] = await closuresOf(loans.paid)
    expect(more).toHaveLength(0)
    expect(closure).toMatchObject({ deviceId: devices.paid, noticeLoggedAt: null, messageOutcome: null, letterStoragePath: null, removedAt: null })
  }, 300_000)

  it("a lease closed by its settled end of term opens one closure", async () => {
    await payAllOwed(database(), fx, loans.lease)
    await testSetup(database(), [`INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "status", "inspectedOn", "inspectedById", "inspectionCondition", "updatedAt")
      VALUES ($1, $2, $3, 'EXPIRY', 'RETURN', 'INVOICED', CURRENT_DATE, $4, 'Synthetic: returned in good order', now())`, `eot_${t}`, fx.tenantId, loans.lease, fx.officer])
    expect(await database().$transaction((tx) => completeEndOfTermIfSettled(tx as never, { tenantId: fx.tenantId, loanId: loans.lease, userId: fx.officer }))).toBe(true)
    expect(await closuresOf(loans.lease)).toMatchObject([{ deviceId: devices.lease }])
  }, 300_000)

  it("any other completion opens one too, and completing again opens no second", async () => {
    await database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() WHERE "id" = $1`, loans.other)
    expect(await closuresOf(loans.other)).toHaveLength(1)
    await testSetup(database(), [`UPDATE "Loan" SET "status" = 'ACTIVE' WHERE "id" = $1`, loans.other])
    await database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED' WHERE "id" = $1`, loans.other)
    expect(await closuresOf(loans.other)).toHaveLength(1)
  }, 120_000)

  it("a device removed before the loan completes has no closure", async () => {
    expect(await removeTrackerDevice(officer(), devices.removed, {})).toEqual({ kind: "ok" })
    await database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() WHERE "id" = $1`, loans.removed)
    expect(await closuresOf(loans.removed)).toHaveLength(0)
  }, 120_000)

  it("with no email set up: the notice is logged, the email decided BLOCKED, the letter stored, each once; nothing dispatched", async () => {
    expect(await database().messageTemplate.count({ where: { tenantId: fx.tenantId } })).toBe(0)
    expect(await process_()).toEqual({ closures: 3, failed: 0 })
    expect(await database().messageTemplate.findMany({ where: { tenantId: fx.tenantId }, select: { key: true } })).toEqual([{ key: "asset_finance_tracking_stopped_email" }])
    const closures = await database().trackerClosure.findMany({ where: { tenantId: fx.tenantId } })
    expect(closures).toHaveLength(3)
    for (const c of closures) {
      expect(c.noticeLoggedAt).not.toBeNull()
      expect(c.messageOutcome).toBe("BLOCKED")
      expect(c.letterStoragePath).not.toBeNull()
      const pdf = await readFile(c.letterStoragePath ?? "")
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-")
    }
    expect(dispatch).not.toHaveBeenCalled()
    const notices = await database().notificationLog.count({ where: { tenantId: fx.tenantId, event: TRACKING_STOPPED_EVENT } })
    // Run again: nothing more happens.
    const before = closures.map((c) => [c.id, c.noticeLoggedAt, c.messageDecidedAt, c.letterGeneratedAt, c.letterSha256])
    expect(await process_()).toEqual({ closures: 0, failed: 0 })
    const after = await database().trackerClosure.findMany({ where: { tenantId: fx.tenantId } })
    expect(after.map((c) => [c.id, c.noticeLoggedAt, c.messageDecidedAt, c.letterGeneratedAt, c.letterSha256])).toEqual(before)
    expect(await database().notificationLog.count({ where: { tenantId: fx.tenantId, event: TRACKING_STOPPED_EVENT } })).toBe(notices)
    const audit = await database().auditLog.groupBy({ by: ["action"], where: { tenantId: fx.tenantId, action: { startsWith: "TRACKER_CLOSURE" } }, _count: true })
    expect(Object.fromEntries(audit.map((a) => [a.action, a._count]))).toEqual({ TRACKER_CLOSURE_NOTICE_LOGGED: 3, TRACKER_CLOSURE_MESSAGE_DECIDED: 3, TRACKER_CLOSURE_LETTER_STORED: 3 })
  }, 300_000)

  it("with email set up, the borrower's contact known: one email through the real pipeline, the transport faked and called once", async () => {
    // A fresh completion on a new loan, with the lender's email and the borrower contact in place.
    _resetRateLimitStore() // the portal signing limit, in this process's memory: five leases signed by one borrower here
    const assetId = await addAsset(database(), fx)
    const loanId = await bookOperatingLease(database(), fx, setSession, assetId)
    await installDevice(fx, assetId, "SIM-STEADY-9", await loanStartDate(database(), loanId))
    const director = await database().client.findUniqueOrThrow({ where: { id: fx.director } })
    const contact = await database().contact.create({ data: { tenantId: fx.tenantId, clientId: director.id, status: "CLIENT", firstSeenChannel: "MANUAL", firstSeenContext: "synthetic-closure-test" } })
    await database().contactIdentity.create({ data: { tenantId: fx.tenantId, contactId: contact.id, channel: "EMAIL", source: "MANUAL", value: director.email.toLowerCase() } })
    await database().emailConfig.create({ data: { tenantId: fx.tenantId, provider: "IMAP_SMTP", fromName: "Synthetic lender", fromAddress: "sender@synthetic.invalid", smtpHost: "smtp.synthetic.invalid", smtpUser: "synthetic", smtpPass: "synthetic", active: true } })
    vi.mocked(dispatch).mockImplementation(async () => ({ providerMessageId: `synthetic-closure-${randomUUID()}`, acceptedAt: new Date() }))
    await database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() WHERE "id" = $1`, loanId)
    expect(await process_()).toEqual({ closures: 1, failed: 0 })
    expect(await process_()).toEqual({ closures: 0, failed: 0 })
    expect(dispatch).toHaveBeenCalledTimes(1)
    const [closure] = await closuresOf(loanId)
    expect(closure).toMatchObject({ messageOutcome: "SENT" })
    const message = await database().message.findUniqueOrThrow({ where: { id: closure.messageId ?? "" } })
    expect(message).toMatchObject({ channel: "EMAIL", status: "SENT", idempotencyKey: `tracking-stopped:${closure.id}:${director.id}` })
    expect(await database().notificationLog.count({ where: { tenantId: fx.tenantId, loanId, event: TRACKING_STOPPED_EVENT, clientId: director.id } })).toBe(1)
  }, 600_000)

  it("runs at once still log one notice, send one email (decided once) and store one letter per closure", async () => {
    _resetRateLimitStore()
    const assetId = await addAsset(database(), fx)
    const loanId = await bookOperatingLease(database(), fx, setSession, assetId)
    await installDevice(fx, assetId, "SIM-STEADY-8", await loanStartDate(database(), loanId))
    vi.mocked(dispatch).mockClear()
    await database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() WHERE "id" = $1`, loanId)
    const runs = await Promise.all([process_(), process_(), process_()])
    expect(runs.reduce((n, r) => n + r.failed, 0)).toBe(0)
    // A run that met another's send in flight left the email undecided; the next run replays its outcome.
    await process_()
    const [closure] = await closuresOf(loanId)
    expect(closure).toMatchObject({ messageOutcome: "SENT" })
    expect(await database().notificationLog.count({ where: { tenantId: fx.tenantId, loanId, event: TRACKING_STOPPED_EVENT } })).toBe(1)
    expect(dispatch).toHaveBeenCalledTimes(1)
    const audit = await database().auditLog.groupBy({ by: ["action"], where: { tenantId: fx.tenantId, entityId: closure.id }, _count: true })
    expect(Object.fromEntries(audit.map((a) => [a.action, a._count]))).toEqual({ TRACKER_CLOSURE_NOTICE_LOGGED: 1, TRACKER_CLOSURE_MESSAGE_DECIDED: 1, TRACKER_CLOSURE_LETTER_STORED: 1 })
  }, 600_000)

  it("a send in flight elsewhere, or an unexpected error, decides nothing: the next run does", async () => {
    _resetRateLimitStore()
    const assetId = await addAsset(database(), fx)
    const loanId = await bookOperatingLease(database(), fx, setSession, assetId)
    await installDevice(fx, assetId, "SIM-STEADY-7", await loanStartDate(database(), loanId))
    await database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() WHERE "id" = $1`, loanId)
    const run = (send: Parameters<typeof processTrackerClosures>[1]) => withoutTenantScope(() => processTrackerClosures(fx.tenantId, send))
    const message = (await database().message.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "SENT" } }))
    expect(await run(async () => { throw new MessageDispatchConflictError() })).toEqual({ closures: 1, failed: 0 })
    expect((await closuresOf(loanId))[0]).toMatchObject({ messageOutcome: null, noticeLoggedAt: expect.any(Date), letterSha256: expect.any(String) })
    expect(await run(async () => { throw new Error("synthetic transient") })).toEqual({ closures: 1, failed: 1 })
    expect((await closuresOf(loanId))[0]).toMatchObject({ messageOutcome: null })
    expect(await run(async () => ({ ...message, status: "QUEUED" }))).toEqual({ closures: 1, failed: 0 })
    expect((await closuresOf(loanId))[0]).toMatchObject({ messageOutcome: null })
    expect(await run(async () => message)).toEqual({ closures: 1, failed: 0 })
    expect((await closuresOf(loanId))[0]).toMatchObject({ messageOutcome: "SENT", messageId: message.id })
  }, 600_000)

  it("a run whose claim on the email is fresh is left alone; a stale claim (a run that died) is taken over", async () => {
    _resetRateLimitStore()
    const assetId = await addAsset(database(), fx)
    const loanId = await bookOperatingLease(database(), fx, setSession, assetId)
    await installDevice(fx, assetId, "SIM-STEADY-6", await loanStartDate(database(), loanId))
    await database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() WHERE "id" = $1`, loanId)
    const [closure] = await closuresOf(loanId)
    const message = await database().message.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "SENT" } })
    let sends = 0
    const send = async () => { sends++; return message }
    await database().trackerClosure.update({ where: { id: closure.id }, data: { messageClaimedAt: new Date() } })
    await withoutTenantScope(() => processTrackerClosures(fx.tenantId, send))
    expect(sends).toBe(0)
    expect((await closuresOf(loanId))[0]).toMatchObject({ messageOutcome: null })
    await database().trackerClosure.update({ where: { id: closure.id }, data: { messageClaimedAt: new Date(Date.now() - MESSAGE_CLAIM_STALE_MS - 1_000) } })
    await withoutTenantScope(() => processTrackerClosures(fx.tenantId, send))
    expect(sends).toBe(1)
    expect((await closuresOf(loanId))[0]).toMatchObject({ messageOutcome: "SENT" })
    await ruleRefuses(database(), { table: "TrackerClosure", trigger: "TrackerClosure_guard" }, /recorded once/,
      (tx) => tx.trackerClosure.update({ where: { id: closure.id }, data: { messageClaimedAt: null } }))
  }, 600_000)

  it("never writes to a deceased borrower: a sole proprietor marked deceased gets no email, the letter is still stored", async () => {
    _resetRateLimitStore()
    const assetId = await addAsset(database(), fx)
    const loanId = await bookOperatingLease(database(), fx, setSession, assetId)
    await installDevice(fx, assetId, "SIM-STEADY-5", await loanStartDate(database(), loanId))
    // Completed, then the lessee made a sole proprietor borrower (test setup, triggers off) with an email Contact, recorded deceased.
    const lessee = await database().client.findUniqueOrThrow({ where: { id: fx.lessee } })
    await database().$executeRawUnsafe(`UPDATE "Loan" SET "status" = 'COMPLETED', "closedAt" = now() WHERE "id" = $1`, loanId)
    await testSetup(database(), [`UPDATE "Loan" SET "clientId" = $2, "entityId" = NULL WHERE "id" = $1`, loanId, fx.lessee],
      [`UPDATE "Client" SET "deceasedAt" = now() WHERE "id" = $1`, fx.lessee])
    const contact = await database().contact.create({ data: { tenantId: fx.tenantId, clientId: lessee.id, status: "CLIENT", firstSeenChannel: "MANUAL", firstSeenContext: "synthetic-closure-test" } })
    await database().contactIdentity.create({ data: { tenantId: fx.tenantId, contactId: contact.id, channel: "EMAIL", source: "MANUAL", value: lessee.email.toLowerCase() } })
    let sends = 0
    const message = await database().message.findFirstOrThrow({ where: { tenantId: fx.tenantId, status: "SENT" } })
    expect(await withoutTenantScope(() => processTrackerClosures(fx.tenantId, async () => { sends++; return message }))).toEqual({ closures: 1, failed: 0 })
    expect(sends).toBe(0)
    expect((await closuresOf(loanId))[0]).toMatchObject({ messageOutcome: "BLOCKED", messageNote: "No recipient with trusted contact details", letterSha256: expect.any(String) })
    expect(await database().notificationLog.count({ where: { tenantId: fx.tenantId, loanId } })).toBe(0)
    await testSetup(database(), [`UPDATE "Client" SET "deceasedAt" = NULL WHERE "id" = $1`, fx.lessee])
  }, 600_000)

  it("removing the device closes the task; the database records each step once and never deletes a closure", async () => {
    const [closure] = await closuresOf(loans.paid)
    expect(await removeTrackerDevice(officer(), devices.paid, {})).toEqual({ kind: "ok" })
    expect((await database().trackerClosure.findUniqueOrThrow({ where: { id: closure.id } }))).toMatchObject({ removedById: fx.officer })
    const guard = { table: "TrackerClosure", trigger: "TrackerClosure_guard" }
    const ONCE = /recorded once/
    await ruleRefuses(database(), guard, ONCE, (tx) => tx.trackerClosure.update({ where: { id: closure.id }, data: { messageOutcome: "SENT", messageNote: "rewritten" } }))
    await ruleRefuses(database(), guard, ONCE, (tx) => tx.trackerClosure.update({ where: { id: closure.id }, data: { noticeLoggedAt: new Date() } }))
    await ruleRefuses(database(), guard, ONCE, (tx) => tx.trackerClosure.update({ where: { id: closure.id }, data: { letterSha256: "0".repeat(64) } }))
    await ruleRefuses(database(), guard, ONCE, (tx) => tx.trackerClosure.update({ where: { id: closure.id }, data: { removedAt: new Date() } }))
    await ruleRefuses(database(), guard, /never deleted/, (tx) => tx.trackerClosure.delete({ where: { id: closure.id } }))
    // Done only when the device is removed; opened only for a completed loan's active device.
    const [other] = await closuresOf(loans.other)
    await ruleRefuses(database(), { fn: "guardTrackerClosure", replace: [`AND d."status" = 'REMOVED') THEN`, `) THEN`] }, /done when its device is removed/,
      (tx) => tx.trackerClosure.update({ where: { id: other.id }, data: { removedAt: new Date(), removedById: fx.officer } }))
    await ruleRefuses(database(), guard, /opened for a completed loan's active device/,
      (tx) => tx.trackerClosure.create({ data: { tenantId: fx.tenantId, loanId: loans.removed, deviceId: devices.removed, closedAt: new Date() } }))
  }, 120_000)
})
