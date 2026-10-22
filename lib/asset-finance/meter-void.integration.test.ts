/**
 * Voiding a wrong meter reading on real Postgres (docs/asset-finance/
 * SLICE5-FOLLOWUPS.md part T): requested by one user with a reason, decided
 * by a second (the database refuses the requester deciding, a second open
 * request, any other change to a reading or a void, and a delete); refused
 * for a final reading, a recovery's or a claim's reading and an invoiced
 * lease; a voided reading counts for nothing: the monotonic floor, the start
 * reading (the pace ceiling and the excess projection), the one telematics
 * reading a day, and it is never cited afterwards.
 *
 *   RUN_ASSET_FINANCE_TELEMATICS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/meter-void.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { runWithTenant } from "@/lib/tenant-scope"
import { loadLeaseStaffData } from "@/components/asset-finance/lease/lease-staff-data"
import { addAsset, bookOperatingLease, cleanupTelematicsFixture, createTelematicsFixture, daysAgo, installDevice, telematicsTestClient, today } from "@/lib/telematics/telematics.integration-fixture"
import { pollTenant } from "@/lib/telematics/poll"
import { attempt, ruleAdmits, ruleRefuses, testSetup } from "./lease-servicing.integration-fixture"
import type { LeaseFixture } from "./lease.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"
import { recordMeterReading } from "./meter-readings"
import { decideMeterReadingVoid, requestMeterReadingVoid } from "./meter-void"
import type { SigningTx } from "./signing-prepare"
import type { LeaseActionResult } from "./lease-route"
import { dbDate } from "./dates"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_TELEMATICS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? telematicsTestClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: LeaseFixture
const ids = { loan: "", wrong: "", start: "" }
type Tx = Parameters<Parameters<PrismaClient["$transaction"]>[0]>[0]

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_TELEMATICS_IT=1 is required")
  return db
}
const setSession = (user: SessionUser | null) => {
  session.current = user && { user }
}
const actor = (userId: string) => ({ tenantId: fx.tenantId, userId, userEmail: `${userId}@void-it.test` })
const inTx = <T,>(fn: (tx: SigningTx) => Promise<T>) => database().$transaction((tx) => fn(tx as unknown as SigningTx))
const request = (userId: string, readingId: string, reason: unknown = "Typed 9 000 for 1 090: a slip of the keyboard") =>
  inTx<LeaseActionResult & { voidId?: string }>((tx) => requestMeterReadingVoid(tx, actor(userId), { loanId: ids.loan, readingId, reason }))
const decide = (userId: string, voidId: string, decision: "APPROVE" | "REJECT") =>
  inTx((tx) => decideMeterReadingVoid(tx, actor(userId), { loanId: ids.loan, voidId, decision }))
const record = (readingDate: string, value: number) =>
  inTx((tx) => recordMeterReading(tx, actor(fx.officer), { loanId: ids.loan, readingDate, value, evidenceDocumentId: null, today: today() }))
const reading = (id: string) => database().assetMeterReading.findUniqueOrThrow({ where: { id } })
/** A reading written in the attack's transaction (as staff would record it). */
const insertReading = (tx: Tx, readingDate: string, value: number, source: "STAFF" | "TELEMATICS" = "STAFF") =>
  tx.assetMeterReading.create({ data: { tenantId: fx.tenantId, loanId: ids.loan, assetId: fx.assets[1], readingDate: dbDate(readingDate), value, unit: "HOURS", source, recordedById: source === "STAFF" ? fx.officer : null }, select: { id: true } })
/** Request (officer) and approve (adminA) a void of `readingId` in the attack's transaction, by SQL as a bypassing path would. */
async function voidIn(tx: Tx, readingId: string): Promise<void> {
  const id = `mv_${randomUUID()}`
  await tx.$executeRawUnsafe(`INSERT INTO "AssetMeterReadingVoid" ("id", "tenantId", "readingId", "reason", "requestedById") VALUES ($1, $2, $3, 'A synthetic wrong reading', $4)`, id, fx.tenantId, readingId, fx.officer)
  await tx.$executeRawUnsafe(`UPDATE "AssetMeterReadingVoid" SET "status" = 'APPROVED', "decidedById" = $2, "decidedAt" = now() WHERE "id" = $1`, id, fx.adminA)
}

suite.sequential("meter-reading void: four-eyes, refusals, a voided reading counts for nothing (real DB)", () => {
  beforeAll(async () => {
    fx = await createTelematicsFixture(database(), t)
    ids.loan = await bookOperatingLease(database(), fx, setSession, fx.assets[1])
    ids.start = (await database().assetMeterReading.findFirstOrThrow({ where: { loanId: ids.loan }, orderBy: { readingDate: "asc" } })).id
  }, 600_000)

  afterAll(async () => {
    await cleanupTelematicsFixture(db, t)
    await db?.$disconnect()
  }, 60_000)

  it("a wrong reading blocks a true one below it, until a second person approves its void", async () => {
    const wrong = await record(daysAgo(10), 9_000)
    expect(wrong).toMatchObject({ kind: "recorded" })
    ids.wrong = (wrong as { readingId: string }).readingId
    expect(await record(daysAgo(5), 1_090)).toMatchObject({ kind: "refused", reason: "not_monotonic" })
    expect(await request(fx.officer, ids.wrong, "too short")).toMatchObject({ kind: "refused", reason: "invalid_reason" })
    const asked = await request(fx.officer, ids.wrong)
    expect(asked).toMatchObject({ kind: "requested" })
    const voidId = (asked as { voidId: string }).voidId
    expect(await request(fx.adminA, ids.wrong)).toMatchObject({ kind: "refused", reason: "void_pending" })
    expect(await decide(fx.officer, voidId, "APPROVE")).toMatchObject({ kind: "refused", reason: "four_eyes" })
    expect((await reading(ids.wrong)).voidedAt).toBeNull()
    expect(await decide(fx.adminA, voidId, "APPROVE")).toEqual({ kind: "decided", status: "APPROVED" })
    expect(await decide(fx.adminB, voidId, "REJECT")).toMatchObject({ kind: "refused", reason: "void_decided" })
    const voided = await reading(ids.wrong)
    expect(voided).toMatchObject({ voidId, value: 9_000 })
    expect(voided.voidedAt).not.toBeNull()
    const audit = await database().auditLog.findMany({ where: { tenantId: fx.tenantId, entityId: ids.wrong, action: { startsWith: "METER_READING_VOID" } }, orderBy: { createdAt: "asc" } })
    expect(audit.map((a) => [a.action, a.userId])).toEqual([["METER_READING_VOID_REQUESTED", fx.officer], ["METER_READING_VOID_APPROVED", fx.adminA]])
    // Now the true reading goes in: the voided one is no floor.
    expect(await record(daysAgo(5), 1_090)).toMatchObject({ kind: "recorded" })
    expect(await request(fx.officer, ids.wrong)).toMatchObject({ kind: "refused", reason: "void_refused", error: "This reading is already void" })
  }, 120_000)

  it("a rejected void leaves the reading as it was", async () => {
    const r = await record(daysAgo(4), 1_100)
    const readingId = (r as { readingId: string }).readingId
    const voidId = ((await request(fx.officer, readingId)) as { voidId: string }).voidId
    expect(await decide(fx.adminA, voidId, "REJECT")).toEqual({ kind: "decided", status: "REJECTED" })
    expect((await reading(readingId)).voidedAt).toBeNull()
    expect(await database().assetMeterReadingVoid.findUniqueOrThrow({ where: { id: voidId } })).toMatchObject({ status: "REJECTED", decidedById: fx.adminA })
  }, 120_000)

  it("holds four-eyes, one open request, and a decided void in the database", async () => {
    const pending = async (tx: Tx) => {
      const { id } = await insertReading(tx, daysAgo(3), 1_110)
      const v = `mv_${randomUUID()}`
      await tx.$executeRawUnsafe(`INSERT INTO "AssetMeterReadingVoid" ("id", "tenantId", "readingId", "reason", "requestedById") VALUES ($1, $2, $3, 'A synthetic wrong reading', $4)`, v, fx.tenantId, id, fx.officer)
      return { readingId: id, voidId: v }
    }
    await ruleRefuses(database(), { table: "AssetMeterReadingVoid", constraint: "AssetMeterReadingVoid_four_eyes" }, /AssetMeterReadingVoid_four_eyes/, async (tx) => {
      const { voidId } = await pending(tx)
      await tx.$executeRawUnsafe(`UPDATE "AssetMeterReadingVoid" SET "status" = 'APPROVED', "decidedById" = "requestedById", "decidedAt" = now() WHERE "id" = $1`, voidId)
    })
    await ruleRefuses(database(), { index: "AssetMeterReadingVoid_one_open" }, /already exists/, async (tx) => {
      const { readingId } = await pending(tx)
      await tx.$executeRawUnsafe(`INSERT INTO "AssetMeterReadingVoid" ("id", "tenantId", "readingId", "reason", "requestedById") VALUES ($1, $2, $3, 'A second synthetic request', $4)`, `mv_${randomUUID()}`, fx.tenantId, readingId, fx.adminA)
    })
    const decided = /decided once, and nothing else about it changes/
    const guard = { table: "AssetMeterReadingVoid", trigger: "AssetMeterReadingVoid_guard" }
    const approved = await database().assetMeterReadingVoid.findFirstOrThrow({ where: { readingId: ids.wrong } })
    await ruleRefuses(database(), { table: "AssetMeterReadingVoid", trigger: "AssetMeterReadingVoid_guard" }, decided,
      (tx) => tx.$executeRawUnsafe(`UPDATE "AssetMeterReadingVoid" SET "status" = 'REJECTED' WHERE "id" = $1`, approved.id))
    await ruleRefuses(database(), guard, decided, async (tx) => {
      const { voidId } = await pending(tx)
      await tx.$executeRawUnsafe(`UPDATE "AssetMeterReadingVoid" SET "reason" = 'Another synthetic reason' WHERE "id" = $1`, voidId)
    })
    await ruleRefuses(database(), guard, /never deleted/, async (tx) => {
      const { voidId } = await pending(tx)
      await tx.$executeRawUnsafe(`DELETE FROM "AssetMeterReadingVoid" WHERE "id" = $1`, voidId)
    })
    await ruleRefuses(database(), guard, /requested PENDING/, (tx) => tx.$executeRawUnsafe(
      `INSERT INTO "AssetMeterReadingVoid" ("id", "tenantId", "readingId", "reason", "status", "requestedById", "decidedById", "decidedAt") VALUES ($1, $2, $3, 'A synthetic wrong reading', 'APPROVED', $4, $5, now())`,
      `mv_${randomUUID()}`, fx.tenantId, ids.start, fx.officer, fx.adminA))
  }, 120_000)

  it("a reading changes only by an approved void of itself; never deleted", async () => {
    const immutable = /only an approved void marks it/
    const guard = { table: "AssetMeterReading", trigger: "AssetMeterReading_guard" }
    await ruleRefuses(database(), guard, immutable, (tx) => tx.assetMeterReading.update({ where: { id: ids.start }, data: { value: 1_001 } }))
    await ruleRefuses(database(), guard, immutable, (tx) => tx.assetMeterReading.update({ where: { id: ids.start }, data: { voidedAt: new Date() } }))
    // Marked with an approved void of another reading (that void approved with its stamp skipped: test setup).
    await ruleRefuses(database(), { fn: "guardAssetMeterReading", replace: [`AND v."readingId" = NEW."id"`, ""] }, immutable, async (tx) => {
      const { id } = await insertReading(tx, today(), 1_500)
      const v = `mv_${randomUUID()}`
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`INSERT INTO "AssetMeterReadingVoid" ("id", "tenantId", "readingId", "reason", "status", "requestedById", "decidedById", "decidedAt")
        VALUES ($1, $2, $3, 'A synthetic wrong reading', 'APPROVED', $4, $5, '2026-01-01')`, v, fx.tenantId, id, fx.officer, fx.adminA)
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = origin`)
      await tx.$executeRawUnsafe(`UPDATE "AssetMeterReading" SET "voidedAt" = '2026-01-01', "voidId" = $2 WHERE "id" = $1`, ids.start, v)
    })
    await ruleRefuses(database(), guard, /immutable/, async (tx) => {
      const { id } = await insertReading(tx, today(), 1_500)
      await tx.assetMeterReading.delete({ where: { id } })
    })
  }, 120_000)

  it("refuses a void of a final reading, a recovery's or a claim's reading, and any reading of an invoiced lease", async () => {
    const refusal = (readingId: string) => database().$queryRawUnsafe<{ r: string | null }[]>(`SELECT "meterReadingVoidRefusal"($1, $2) AS r`, fx.tenantId, readingId).then((rows) => rows[0].r)
    // Each citing row is written with triggers off (its own rules are not this test's subject) and removed after.
    const cases: [string, string, RegExp][] = [
      [`INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "finalReadingId", "updatedAt") SELECT 'eot_${t}', $1, $2, 'EXPIRY', 'RETURN', $3, now() WHERE $4::text IS NOT NULL`,
        `DELETE FROM "LeaseEndOfTerm" WHERE "id" = 'eot_${t}'`, /final reading of an end of term/],
      [`INSERT INTO "Recovery" ("id", "tenantId", "loanId", "assetId", "route", "status", "recoveredOn", "location", "condition", "createdById", "meterReadingId", "updatedAt")
        SELECT 'rc_${t}', $1, $2, l."assetId", 'NON_NCA_COURT_ORDER', 'RECOVERED', CURRENT_DATE, 'Synthetic yard', 'Synthetic condition', $4, $3, now() FROM "Loan" l WHERE l."id" = $2`,
        `DELETE FROM "Recovery" WHERE "id" = 'rc_${t}'`, /recovery or a maintenance claim/],
      [`INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "taxInvoiceId", "updatedAt") SELECT 'eot_${t}', $1, $2, 'EXPIRY', 'RETURN', 'ti_${t}', now() WHERE $3::text IS NOT NULL AND $4::text IS NOT NULL`,
        `DELETE FROM "LeaseEndOfTerm" WHERE "id" = 'eot_${t}'`, /end of term is invoiced/],
    ]
    let value = 1_200
    for (const [setup, teardown, expected] of cases) {
      const r = ((await record(today(), value += 10)) as { readingId: string }).readingId
      await testSetup(database(), [setup, fx.tenantId, ids.loan, r, fx.officer])
      expect(await refusal(r)).toMatch(expected)
      expect(await request(fx.officer, r)).toMatchObject({ kind: "refused", reason: "void_refused" })
      await expect(database().$executeRawUnsafe(`INSERT INTO "AssetMeterReadingVoid" ("id", "tenantId", "readingId", "reason", "requestedById") VALUES ($1, $2, $3, 'A synthetic wrong reading', $4)`,
        `mv_${randomUUID()}`, fx.tenantId, r, fx.officer)).rejects.toThrow(expected)
      await testSetup(database(), [teardown])
      expect(await refusal(r)).toBeNull()
    }
    // A claim's reading is refused the same way (the CASE names both).
    await ruleRefuses(database(), { fn: "meterReadingVoidRefusal", replace: [`OR EXISTS (SELECT 1 FROM "MaintenanceClaim" c WHERE c."tenantId" = m."tenantId" AND c."meterReadingId" = m."id")`, ""] },
      /recovery or a maintenance claim/, async (tx) => {
        const { id } = await insertReading(tx, today(), 1_290)
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
        await tx.$executeRawUnsafe(`INSERT INTO "MaintenanceClaim" ("id", "tenantId", "fundId", "supplierId", "providerInvoiceDocumentId", "meterReadingId", "amountExclVatCents", "description", "submittedById")
          VALUES ($1, $2, 'fund_x', 'sup_x', 'doc_x', $3, 100, 'Synthetic service', $4)`, `mc_${t}`, fx.tenantId, id, fx.officer)
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = origin`)
        await tx.$executeRawUnsafe(`INSERT INTO "AssetMeterReadingVoid" ("id", "tenantId", "readingId", "reason", "requestedById") VALUES ($1, $2, $3, 'A synthetic wrong reading', $4)`, `mv_${randomUUID()}`, fx.tenantId, id, fx.officer)
      })
  }, 120_000)

  it("a voided reading is never cited afterwards as a final, a recovery's or a claim's reading", async () => {
    // Each citing row skips its own other rules and keys (replica session): only guardNotVoidedReading is under test, made to fire there
    // (ENABLE ALWAYS) unless ruleRefuses has switched it off.
    const only = (table: string, trigger: string, sql: string) => async (tx: Tx) => {
      const { id } = await insertReading(tx, today(), 1_400)
      await voidIn(tx, id)
      const [state] = await tx.$queryRawUnsafe<{ on: boolean }[]>(`SELECT tgenabled <> 'D' AS on FROM pg_trigger WHERE tgrelid = '"${table}"'::regclass AND tgname = $1`, trigger)
      if (state.on) await tx.$executeRawUnsafe(`ALTER TABLE "${table}" ENABLE ALWAYS TRIGGER "${trigger}"`)
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(sql, fx.tenantId, ids.loan, id, fx.officer)
    }
    const NOT_RELIED = /voided meter reading is not relied on/
    await ruleRefuses(database(), { table: "LeaseEndOfTerm", trigger: "LeaseEndOfTerm_not_voided_reading" }, NOT_RELIED, only("LeaseEndOfTerm", "LeaseEndOfTerm_not_voided_reading",
      `INSERT INTO "LeaseEndOfTerm" ("id", "tenantId", "loanId", "origin", "outcome", "finalReadingId", "updatedAt") SELECT 'eotv_${t}', $1, $2, 'EXPIRY', 'RETURN', $3, now() WHERE $4::text IS NOT NULL`))
    await ruleRefuses(database(), { table: "Recovery", trigger: "Recovery_not_voided_reading" }, NOT_RELIED, only("Recovery", "Recovery_not_voided_reading",
      `INSERT INTO "Recovery" ("id", "tenantId", "loanId", "assetId", "route", "status", "recoveredOn", "location", "condition", "createdById", "meterReadingId", "updatedAt")
        SELECT 'rcv_${t}', $1, $2, l."assetId", 'NON_NCA_COURT_ORDER', 'RECOVERED', CURRENT_DATE, 'Synthetic yard', 'Synthetic condition', $4, $3, now() FROM "Loan" l WHERE l."id" = $2`))
    await ruleRefuses(database(), { table: "MaintenanceClaim", trigger: "MaintenanceClaim_not_voided_reading" }, NOT_RELIED, only("MaintenanceClaim", "MaintenanceClaim_not_voided_reading",
      `INSERT INTO "MaintenanceClaim" ("id", "tenantId", "fundId", "supplierId", "providerInvoiceDocumentId", "meterReadingId", "amountExclVatCents", "description", "submittedById")
        SELECT 'mcv_${t}', $1, 'fund_x', 'sup_x', 'doc_x', $3, 100, 'Synthetic service', $4 WHERE $2::text IS NOT NULL`))
  }, 120_000)

  it("a voided start reading is no start: the pace ceiling and the excess projection move to the next reading", async () => {
    const ceiling = async (tx: Tx) => (await tx.$queryRawUnsafe<{ c: number }[]>(`SELECT "telematicsPaceCeiling"($1, $2, $3::date) AS c`, fx.tenantId, ids.loan, today()))[0].c
    const before = await ceiling(database() as unknown as Tx)
    const projection = () => runWithTenant(fx.tenantId, () => loadLeaseStaffData(fx.tenantId, ids.loan)).then((d) => d?.usage)
    const used = (await projection())?.usedUnits ?? 0
    expect(used).toBeGreaterThan(0)
    const voidId = ((await request(fx.officer, ids.start, "The start reading was taken from the wrong machine")) as { voidId: string }).voidId
    expect(await decide(fx.adminB, voidId, "APPROVE")).toEqual({ kind: "decided", status: "APPROVED" })
    const after = await ceiling(database() as unknown as Tx)
    // The next live reading is 1 090 h, five days ago: the ceiling starts from it (3 x 1 500 h a year, plus a month).
    expect(after).toBe(1_090 + Math.ceil(1_500 * 3 * (5 + 31) / 365))
    expect(after).not.toBe(before)
    expect((await projection())?.usedUnits).toBe(used - (1_090 - 1_000))
    const staff = await runWithTenant(fx.tenantId, () => loadLeaseStaffData(fx.tenantId, ids.loan))
    expect(staff?.readings.find((r) => r.id === ids.start)).toMatchObject({ voidedOn: today(), pendingVoid: null })
  }, 120_000)

  it("a voided telematics reading leaves its day free for another", async () => {
    // A second lease with a simulated tracker: one TELEMATICS reading a day.
    const assetId = await addAsset(database(), fx)
    const loanId = await bookOperatingLease(database(), fx, setSession, assetId)
    await installDevice(fx, assetId, "SIM-STEADY-1", daysAgo(30))
    expect(await pollTenant(fx.tenantId, new Date())).toMatchObject({ ok: true, failed: 0 })
    const telematics = await database().assetMeterReading.findFirstOrThrow({ where: { loanId, source: "TELEMATICS" }, orderBy: { readingDate: "desc" } })
    // A second reading that day (a copy, new id and event; written with the triggers off: only the index is under test).
    const secondThatDay = async (tx: Tx, voidFirst: boolean) => {
      if (voidFirst) await voidIn(tx, telematics.id)
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`INSERT INTO "AssetMeterReading" SELECT (jsonb_populate_record(NULL::"AssetMeterReading", to_jsonb(m)
        || jsonb_build_object('id', $2::text, 'telematicsEventId', $3::text, 'voidedAt', NULL, 'voidId', NULL))).* FROM "AssetMeterReading" m WHERE m."id" = $1`,
        telematics.id, `mr_${randomUUID()}`, `ev_${randomUUID()}`)
    }
    expect(await attempt(database(), (tx) => secondThatDay(tx, false))).toMatch(/already exists/)
    await ruleAdmits(database(), (tx) => secondThatDay(tx, true))
  }, 600_000)
})
