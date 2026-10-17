/**
 * Real-Postgres proof of the SARB reference-rate feed: the database rules of a
 * value no user recorded (migration 20261016130000) and the sync that writes
 * it, with the real decide route.
 *
 * Only the session is stubbed: the role guard, the tenant resolver (by host),
 * the feature flag, the decide route, the audit writer, the tenant-scope
 * extension and the database rules are real. The feed itself is never called
 * (observations are passed in).
 *
 *   RUN_ASSET_FINANCE_RATE_FEED_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/rate-feed.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { Prisma, PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const { session } = vi.hoisted(() => ({
  session: { current: null as null | { user: { id: string; email: string; role: string; tenantId: string } } },
}))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

import { prisma } from "@/lib/prisma"
import { parseSarbHistory } from "./sarb-effective-rates"
import { referenceRateOn } from "./rates-store"
import { runReferenceRateFeed, syncReferenceRatesFromFeed } from "./rate-feed-sync"
import type { SarbObservation } from "./sarb-rate-feed"
import { POST as decide } from "@/app/api/asset-finance/reference-rates/[id]/decide/route"

const RUN = process.env.RUN_ASSET_FINANCE_RATE_FEED_IT === "1"
const suite = RUN ? describe : describe.skip
const db = new PrismaClient()

const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_af_feed_${t}`
const otherTenantId = `t_af_feed_off_${t}`
const host = `af-feed-${t}.feed-it.test`
const ids = { adminA: "", adminB: "" }
const today = "2026-10-16"

const obs = (basis: "PRIME" | "REPO" | "ZARONIA", rate: string, effectiveDate = today): SarbObservation =>
  ({ basis, timeseriesCode: "IT", effectiveDate, rate: new Prisma.Decimal(rate) })
const insertFeedRow = (over: Partial<Prisma.ReferenceRateUncheckedCreateInput> = {}) =>
  db.referenceRate.create({ data: { tenantId, basis: "PRIME", effectiveDate: new Date("2026-01-15"), rate: "0.1175", source: "SARB_FEED", ...over } })
const decideAs = async (userId: string, rateId: string, decision: "APPROVE" | "REJECT") => {
  session.current = { user: { id: userId, email: `${userId}@feed-it.test`, role: "LOAN_ADMIN", tenantId } }
  const req = new NextRequest(`http://${host}/api/asset-finance/reference-rates/${rateId}/decide`, {
    method: "POST", headers: { host, "content-type": "application/json" }, body: JSON.stringify({ decision }),
  })
  return decide(req, { params: Promise.resolve({ id: rateId }) })
}
// A CHECK or trigger violation must name the rule it broke.
const refused = (promise: Promise<unknown>, rule: string | RegExp) => expect(promise).rejects.toThrow(rule)
let seq = 0
const nextDate = () => new Date(Date.UTC(2025, 0, 1 + ++seq))

suite.sequential("SARB reference-rate feed (real Postgres)", () => {
  beforeAll(async () => {
    for (const [id, flag] of [[tenantId, true], [otherTenantId, false]] as const) {
      await db.tenant.create({ data: { id, slug: `af-feed-${flag ? "on" : "off"}-${t}`, name: "Feed IT", ...(flag ? { domain: host } : {}) } })
      await db.tenantConfig.create({ data: { tenantId: id, featureAssetFinance: flag } })
    }
    const user = (label: string) => db.user.create({ data: { tenantId, email: `${label}-${t}@staff.invalid`, password: "x", role: "LOAN_ADMIN" } })
    ids.adminA = (await user("admin-a")).id
    ids.adminB = (await user("admin-b")).id
  })

  afterAll(async () => {
    for (const id of [tenantId, otherTenantId]) {
      await db.notification.deleteMany({ where: { tenantId: id } })
      await db.auditLog.deleteMany({ where: { tenantId: id } })
    }
    await db.auditLog.deleteMany({ where: { action: "REFERENCE_RATE_FEED_FAILED", newValue: { path: ["detail"], equals: `it-${t}` } } })
    // An approved value is never deleted (guardReferenceRateLifecycle); only this test's rows go.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.referenceRate.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } }),
    ])
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId: { in: [tenantId, otherTenantId] } } })
    await db.tenant.deleteMany({ where: { id: { in: [tenantId, otherTenantId] } } })
    await db.$disconnect()
    await prisma.$disconnect()
  })

  describe("database rules", () => {
    it("a SARB_FEED value with no requester inserts PENDING, undecided (the four-eyes CHECK passes a NULL requester)", async () => {
      const row = await insertFeedRow({ effectiveDate: nextDate() })
      expect(row).toMatchObject({ status: "PENDING", source: "SARB_FEED", requestedById: null, decidedById: null, decidedAt: null })
    })

    it("a MANUAL value defaults its source and needs a requester: NULL is refused, a user is accepted", async () => {
      await refused(insertFeedRow({ source: "MANUAL", effectiveDate: nextDate() }), /ReferenceRate_requester_source/)
      const manual = await db.referenceRate.create({ data: { tenantId, basis: "PRIME", effectiveDate: nextDate(), rate: "0.12", requestedById: ids.adminA } })
      expect(manual.source).toBe("MANUAL")
    })

    it("a SARB_FEED value with a requester is refused", async () => {
      await refused(insertFeedRow({ requestedById: ids.adminA, effectiveDate: nextDate() }), /ReferenceRate_requester_source/)
    })

    it("a value cannot be born APPROVED or REJECTED, or with a decider, requester or not", async () => {
      const message = /A reference rate is recorded PENDING and undecided/
      await refused(insertFeedRow({ status: "APPROVED", decidedById: ids.adminA, decidedAt: new Date(), effectiveDate: nextDate() }), message)
      await refused(insertFeedRow({ status: "REJECTED", decidedById: ids.adminA, decidedAt: new Date(), effectiveDate: nextDate() }), message)
      await refused(insertFeedRow({ decidedById: ids.adminA, effectiveDate: nextDate() }), message)
    })

    it("a user approves a feed value, through the real decide route; it is then a rate", async () => {
      const row = await insertFeedRow({ basis: "REPO", effectiveDate: new Date("2026-02-01"), rate: "0.0825" })
      expect(await referenceRateOn(prisma, tenantId, "REPO", today)).toBeNull()
      const response = await decideAs(ids.adminA, row.id, "APPROVE")
      expect(response.status).toBe(200)
      expect(await response.json()).toMatchObject({ status: "APPROVED", source: "SARB_FEED", requestedById: null, decidedById: ids.adminA })
      expect((await referenceRateOn(prisma, tenantId, "REPO", today))?.rate.toString()).toBe("0.0825")
      expect((await decideAs(ids.adminB, row.id, "REJECT")).status).toBe(409)
    })

    it("a user rejects a feed value; it is never a rate", async () => {
      const row = await insertFeedRow({ basis: "JIBAR", effectiveDate: new Date("2026-02-01") })
      expect((await decideAs(ids.adminB, row.id, "REJECT")).status).toBe(200)
      expect(await referenceRateOn(prisma, tenantId, "JIBAR", today)).toBeNull()
    })

    it("a decider cannot be the requester of a manual value, and a feed value is decided by anyone", async () => {
      const manual = await db.referenceRate.create({ data: { tenantId, basis: "LENDER_BASE", effectiveDate: nextDate(), rate: "0.1", requestedById: ids.adminA } })
      await refused(
        db.referenceRate.update({ where: { id: manual.id }, data: { status: "APPROVED", decidedById: ids.adminA } }),
        /ReferenceRate_four_eyes/,
      )
      expect((await decideAs(ids.adminA, (await insertFeedRow({ basis: "LENDER_BASE", effectiveDate: nextDate() })).id, "APPROVE")).status).toBe(200)
    })

    it("source never changes after insert", async () => {
      const feedRow = await insertFeedRow({ effectiveDate: nextDate() })
      await refused(db.referenceRate.update({ where: { id: feedRow.id }, data: { source: "MANUAL" } }), /source and requester never change/)
      await refused(db.referenceRate.update({ where: { id: feedRow.id }, data: { requestedById: ids.adminA } }), /never change/)
      const manual = await db.referenceRate.create({ data: { tenantId, basis: "PRIME", effectiveDate: nextDate(), rate: "0.12", requestedById: ids.adminA } })
      await refused(db.referenceRate.update({ where: { id: manual.id }, data: { source: "SARB_FEED", requestedById: null } }), /never change/)
    })

    it("a decided row is immutable, a feed row included, and an approved one is never deleted", async () => {
      const row = await insertFeedRow({ effectiveDate: nextDate() })
      expect((await decideAs(ids.adminB, row.id, "APPROVE")).status).toBe(200)
      await refused(db.referenceRate.update({ where: { id: row.id }, data: { status: "REJECTED" } }), /A APPROVED reference rate is immutable/)
      await refused(db.referenceRate.update({ where: { id: row.id }, data: { decidedAt: new Date() } }), /immutable/)
      await refused(db.referenceRate.delete({ where: { id: row.id } }), /An approved reference rate is never deleted/)
    })

    it("holds one live value per tenant, basis and date for a feed value too", async () => {
      const date = nextDate()
      await insertFeedRow({ effectiveDate: date })
      await refused(insertFeedRow({ effectiveDate: date, rate: "0.12" }), /ReferenceRate_live_key|Unique constraint/)
    })
  })

  describe("sync, against the real database", () => {
    const rows = (basis: string) => db.referenceRate.findMany({ where: { tenantId, basis: basis as "PRIME" }, orderBy: { effectiveDate: "asc" } })
    // The sync sweeps every flagged tenant in the database. Other suites share
    // it and delete their tenants mid-run, so this file's sweep sees only its own two.
    const scoped = new Proxy(prisma, {
      get(target, key, receiver) {
        if (key !== "tenantConfig") return Reflect.get(target, key, receiver)
        return {
          findMany: ({ where, ...rest }: { where?: Prisma.TenantConfigWhereInput; orderBy: { tenantId: "asc" }; select: { tenantId: true } }) =>
            target.tenantConfig.findMany({ ...rest, where: { AND: [where ?? {}, { tenantId: { in: [tenantId, otherTenantId] } }] } }),
        }
      },
    })
    const feedRun = (observations: SarbObservation[]) => runReferenceRateFeed(scoped, async () => ({ ok: true, observations }))

    it("stores the SARB change date when it precedes the polling date", async () => {
      const history = parseSarbHistory([{ Period: "2026-09-25T00:00:00", Value: 7.25 }], "REPO", "MRDREPOR", "2026-10-17")
      if (!history.ok) throw new Error(history.detail)
      const run = await feedRun(history.observations)
      expect(run).toMatchObject({ ok: true, perTenant: [{ recorded: [{ basis: "REPO", effectiveDate: "2026-09-25", rate: "0.0725" }] }] })
      expect(await db.referenceRate.findFirst({ where: { tenantId, basis: "REPO", source: "SARB_FEED", effectiveDate: new Date("2026-09-25") } })).not.toBeNull()
    })

    it("records PENDING feed rows for a tenant with asset finance on and none for one without", async () => {
      const run = await feedRun([obs("PRIME", "0.1075"), obs("ZARONIA", "0.07097", "2026-10-15")])
      expect(run.ok).toBe(true)
      const created = await db.referenceRate.findMany({ where: { tenantId, effectiveDate: { gte: new Date("2026-10-01") } } })
      expect(created.map((r) => [r.basis, r.status, r.source, r.requestedById, r.rate.toString()]).sort()).toEqual([
        ["PRIME", "PENDING", "SARB_FEED", null, "0.1075"], ["ZARONIA", "PENDING", "SARB_FEED", null, "0.07097"],
      ])
      expect(await db.referenceRate.count({ where: { tenantId: otherTenantId } })).toBe(0)
    })

    it("audits each insert as the system actor and bells every loan admin", async () => {
      const prime = (await rows("PRIME")).find((r) => r.source === "SARB_FEED" && r.rate.toString() === "0.1075")
      if (!prime) throw new Error("the PRIME feed row is missing")
      const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId, entityId: prime.id, action: "REFERENCE_RATE_RECORDED" } })
      expect(audit).toMatchObject({ userId: null, userEmail: "system@sarb-rate-feed" })
      expect(audit.newValue).toMatchObject({ basis: "PRIME", source: "SARB_FEED", effectiveDate: today, status: "PENDING" })
      const bell = await db.notification.findMany({ where: { tenantId, entityId: prime.id }, orderBy: { userId: "asc" } })
      expect(bell.map((n) => [n.userId, n.type, n.title])).toEqual(
        [ids.adminA, ids.adminB].sort().map((id) => [id, "REFERENCE_RATE_FEED_PENDING", `SARB feed: PRIME 10.75% observed ${today} awaits approval`]),
      )
    })

    it("a second run records nothing (same value pending), and no second bell", async () => {
      const before = await db.notification.count({ where: { tenantId } })
      const run = await feedRun([obs("PRIME", "0.1075", "2026-10-17"), obs("ZARONIA", "0.07097", "2026-10-16")])
      expect(run).toMatchObject({ ok: true, perTenant: [{ tenantId, recorded: [], skipped: { unchanged: 2 } }] })
      expect(await db.notification.count({ where: { tenantId } })).toBe(before)
    })

    it("every changed value is recorded, including daily ZARONIA moves", async () => {
      const [run] = await syncReferenceRatesFromFeed(scoped, [obs("PRIME", "0.11", "2026-10-18"), obs("ZARONIA", "0.0725", "2026-10-18")])
      expect(run.recorded.map((r) => [r.basis, r.rate])).toEqual([["PRIME", "0.11"], ["ZARONIA", "0.0725"]])
      expect(run.skipped).toEqual({})
      const [zaronia] = await syncReferenceRatesFromFeed(scoped, [obs("ZARONIA", "0.0723", "2026-10-19")]) // 22.97 bp above 0.07097... still under
      expect(zaronia.recorded.map((r) => r.rate)).toEqual(["0.0723"])
      const [moved] = await syncReferenceRatesFromFeed(scoped, [obs("ZARONIA", "0.0735", "2026-10-20")]) // 25.03 bp
      expect(moved.recorded.map((r) => r.rate)).toEqual(["0.0735"])
    })

    it("records a return to an earlier ZARONIA value on its new effective date despite an older pending equal value", async () => {
      const [run] = await syncReferenceRatesFromFeed(scoped, [obs("ZARONIA", "0.07097", "2026-10-21")])
      expect(run.recorded.map((r) => [r.effectiveDate, r.rate])).toEqual([["2026-10-21", "0.07097"]])
      expect((await rows("ZARONIA")).filter((r) => r.rate.toString() === "0.07097")).toHaveLength(2)
    })

    it("a value already recorded for that date is the live-key P2002: skipped, not failed", async () => {
      await db.referenceRate.create({ data: { tenantId, basis: "REPO", effectiveDate: new Date("2026-10-16"), rate: "0.07", requestedById: ids.adminA } })
      const [run] = await syncReferenceRatesFromFeed(scoped, [obs("REPO", "0.0725", "2026-10-16")])
      expect(run).toMatchObject({ recorded: [], failed: 0, skipped: { already_recorded: 1 } })
    })

    it("an unreadable feed records nothing and leaves an audit row", async () => {
      const before = await db.referenceRate.count({ where: { tenantId } })
      vi.spyOn(console, "error").mockImplementation(() => undefined)
      const run = await runReferenceRateFeed(scoped, async () => ({ ok: false, reason: "timeout", detail: `it-${t}` }))
      expect(run).toMatchObject({ ok: false, reason: "feed_unavailable" })
      expect(await db.referenceRate.count({ where: { tenantId } })).toBe(before)
      const audit = await db.auditLog.findFirstOrThrow({ where: { action: "REFERENCE_RATE_FEED_FAILED", newValue: { path: ["detail"], equals: `it-${t}` } } })
      expect(audit).toMatchObject({ tenantId: null, entity: "ReferenceRateFeed", userEmail: "system@sarb-rate-feed" })
    })
  })
})
