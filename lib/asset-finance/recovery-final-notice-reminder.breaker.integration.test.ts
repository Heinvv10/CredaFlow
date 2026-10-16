/**
 * Breaker repros for the NCA final-notice reminder (real Postgres).
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=... npx vitest run lib/asset-finance/recovery-final-notice-reminder.breaker.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { sastCalendarDate } from "@/lib/date/sast"
import { dbDate, isoOfDbDate } from "./dates"
import { testSetup } from "./lease-servicing.integration-fixture"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { runRecoveryDeadlineSweep } from "./recovery-freeze-deadline"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const d = (): PrismaClient => { if (!db) throw new Error("IT off"); return db }
const t1 = randomUUID().replaceAll("-", "").slice(0, 16)
const t2 = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
let fx2: RecoveryFixture

const freezeOn = (id: string, iso: string) =>
  testSetup(d(), [`UPDATE "Recovery" SET "chargesFrozenFrom" = $1::date WHERE "id" = $2`, iso, id])
const bells = (tenantId: string, id: string) =>
  d().notification.findMany({ where: { tenantId, type: "RECOVERY_FINAL_NOTICE_DUE", entityId: id } })
async function nca(f: RecoveryFixture, frozen: string) {
  const r = await ladderRecovery(d(), f, true, "PROCEEDS_APPLIED")
  await freezeOn(r.id, frozen)
  return r
}

suite.sequential("REPRO F2 breaker", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(d(), t1)
    fx2 = await createRecoveryFixture(d(), t2)
    // Added by the builder: the fixture has no ADMIN, and F2-f expects an inactive creator's reminder to reach one.
    await d().user.create({ data: { tenantId: fx.tenantId, email: `admin-${t1}@staff.invalid`, password: "x", role: "ADMIN" } })
  }, 120_000)
  afterAll(async () => {
    await cleanupRecoveryFixture(d(), recoveryFixtureTenantId(t1)).catch(() => undefined)
    await cleanupRecoveryFixture(d(), recoveryFixtureTenantId(t2)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("F2-a: two concurrent sweeps produce exactly one bell and one marker", async () => {
    const r = await nca(fx, "2027-01-04")
    const day = "2027-01-11"
    const runs = await Promise.all([runRecoveryDeadlineSweep(day), runRecoveryDeadlineSweep(day), runRecoveryDeadlineSweep(day)])
    expect(runs.every((x) => x.failed === 0)).toBe(true)
    expect(await bells(fx.tenantId, r.id)).toHaveLength(1)
    expect(await d().auditLog.count({ where: { tenantId: fx.tenantId, action: "ASSET_RECOVERY_FINAL_NOTICE_REMINDED", entityId: r.id } })).toBe(1)
  }, 60_000)

  it("F2-b: weekend boundary (Fri 2027-01-08 + 5 bd = Fri 2027-01-15)", async () => {
    const r = await nca(fx, "2027-01-08")
    await runRecoveryDeadlineSweep("2027-01-14")
    expect(await bells(fx.tenantId, r.id)).toHaveLength(0)
    await runRecoveryDeadlineSweep("2027-01-15")
    expect(await bells(fx.tenantId, r.id)).toHaveLength(1)
  }, 60_000)

  it("F2-c: public-holiday boundary (Thu 2027-03-18; 22 Mar, Good Friday 26 Mar, Easter Monday 29 Mar skipped => due Tue 2027-03-30)", async () => {
    const r = await nca(fx, "2027-03-18")
    await runRecoveryDeadlineSweep("2027-03-29")
    expect(await bells(fx.tenantId, r.id)).toHaveLength(0)
    await runRecoveryDeadlineSweep("2027-03-30")
    expect(await bells(fx.tenantId, r.id)).toHaveLength(1)
  }, 60_000)

  it("F2-d: recovery that reaches FINAL_NOTICE_ISSUED before the due day is never reminded", async () => {
    const r = await nca(fx, "2027-02-01")
    await runRecoveryDeadlineSweep("2027-02-05")
    await testSetup(d(), [`UPDATE "Recovery" SET "status" = 'FINAL_NOTICE_ISSUED' WHERE "id" = $1`, r.id])
    await runRecoveryDeadlineSweep("2027-02-08")
    expect(await bells(fx.tenantId, r.id)).toHaveLength(0)
  }, 60_000)

  it("F2-e: a recovery of a tenant with featureAssetFinance off is not reminded; the other tenant's still is, and only its own creator is belled", async () => {
    const off = await nca(fx2, "2027-02-01")
    const on = await nca(fx, "2027-02-01")
    await d().tenantConfig.update({ where: { tenantId: fx2.tenantId }, data: { featureAssetFinance: false } })
    await runRecoveryDeadlineSweep("2027-02-08")
    expect(await bells(fx2.tenantId, off.id)).toHaveLength(0)
    const mine = await bells(fx.tenantId, on.id)
    expect(mine).toHaveLength(1)
    expect(mine[0].tenantId).toBe(fx.tenantId)
  }, 60_000)

  it("F2-f: creator deactivated => reminder still lands on a user who can never read it, and the once-only marker is spent (hypothesis-grade finding, reproduced)", async () => {
    const r = await nca(fx, "2027-02-15")
    const creator = (await d().recovery.findUniqueOrThrow({ where: { id: r.id } })).createdById
    await d().user.update({ where: { id: creator }, data: { active: false } })
    try {
      const run = await runRecoveryDeadlineSweep("2027-02-22")
      expect(run.failed).toBe(0)
      const items = await bells(fx.tenantId, r.id)
      // Desired: the reminder reaches someone active (e.g. a tenant admin) instead of a deactivated user.
      const recipients = await d().user.findMany({ where: { id: { in: items.map((i) => i.userId) } }, select: { active: true } })
      expect(recipients.length).toBeGreaterThan(0)
      expect(recipients.every((u) => u.active)).toBe(true)
    } finally {
      await d().user.update({ where: { id: creator }, data: { active: true } })
    }
  }, 60_000)

  it("F2-g: the creator row cannot be deleted (FK Restrict), so a 'deleted creator' state is unreachable", async () => {
    const r = await nca(fx, "2027-02-15")
    const creator = (await d().recovery.findUniqueOrThrow({ where: { id: r.id } })).createdById
    await expect(d().user.delete({ where: { id: creator } })).rejects.toThrow()
  }, 60_000)

  it("F2-h: frozen date in the future / equal to day never reminds", async () => {
    const r = await nca(fx, "2027-06-01")
    await runRecoveryDeadlineSweep("2027-05-01")
    await runRecoveryDeadlineSweep("2027-06-01")
    expect(await bells(fx.tenantId, r.id)).toHaveLength(0)
    expect(isoOfDbDate((await d().recovery.findUniqueOrThrow({ where: { id: r.id } })).chargesFrozenFrom!)).toBe("2027-06-01")
  }, 60_000)
})

// ---- Round 2: lock order and the admin fallback ----
suite.sequential("REPRO F2 round 2", () => {
  const t3 = randomUUID().replaceAll("-", "").slice(0, 16)
  let f3: RecoveryFixture
  beforeAll(async () => { f3 = await createRecoveryFixture(d(), t3) }, 120_000)
  afterAll(async () => { await cleanupRecoveryFixture(d(), recoveryFixtureTenantId(t3)).catch(() => undefined) }, 60_000)

  it("R2-a: sweeps racing the final-notice transition (loan->recovery lock vs recovery->loan trigger locks) neither deadlock nor lose the transition", async () => {
    const recs: Awaited<ReturnType<typeof ladderRecovery>>[] = []
    for (let i = 0; i < 8; i++) recs.push(await ladderRecovery(d(), f3, true, "PROCEEDS_APPLIED"))
    const day = "2027-12-01"
    const issue = (r: (typeof recs)[number]) => d().recovery.update({ where: { id: r.id }, data: { status: "FINAL_NOTICE_ISSUED", finalNoticeIssuedOn: dbDate(sastCalendarDate(new Date())), finalNoticePath: "/nonexistent/fn.pdf", finalNoticeSha256: "a".repeat(64), chargesFrozenUntil: dbDate(addSouthAfricanBusinessDays(sastCalendarDate(new Date()), 10)) } })
    const results = await Promise.allSettled([
      runRecoveryDeadlineSweep(day), runRecoveryDeadlineSweep(day), ...recs.map(issue), runRecoveryDeadlineSweep(day),
    ])
    for (const r of results) if (r.status === "rejected") throw new Error(`rejected: ${String(r.reason)}`)
    const sweeps = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof runRecoveryDeadlineSweep>>> => r.status === "fulfilled" && typeof r.value === "object" && r.value !== null && "failed" in r.value)
    expect(sweeps.every((s) => s.value.failed === 0)).toBe(true)
    for (const r of recs) {
      expect((await d().recovery.findUniqueOrThrow({ where: { id: r.id } })).status).toBe("FINAL_NOTICE_ISSUED")
      expect((await bells(f3.tenantId, r.id)).length).toBeLessThanOrEqual(1)
    }
  }, 120_000)

  it("R2-b: inactive creator, active admins => every active ADMIN/SUPER_ADMIN belled once, nobody inactive, marker once; second run adds nothing", async () => {
    for (const role of ["ADMIN", "SUPER_ADMIN"] as const) await d().user.create({ data: { tenantId: f3.tenantId, email: `${role}-${randomUUID().slice(0, 8)}@staff.invalid`, password: "x", role } })
    const r = await nca(f3, "2027-02-01")
    const creator = (await d().recovery.findUniqueOrThrow({ where: { id: r.id } })).createdById
    await d().user.update({ where: { id: creator }, data: { active: false } })
    try {
      const first = await runRecoveryDeadlineSweep("2027-02-08")
      expect(first.failed).toBe(0)
      await runRecoveryDeadlineSweep("2027-02-09")
      const items = await bells(f3.tenantId, r.id)
      const users = await d().user.findMany({ where: { id: { in: items.map((i) => i.userId) } }, select: { id: true, active: true, role: true, tenantId: true } })
      expect(users.length).toBeGreaterThan(0)
      expect(users.every((u) => u.active && u.tenantId === f3.tenantId && ["ADMIN", "SUPER_ADMIN"].includes(u.role))).toBe(true)
      expect(new Set(items.map((i) => i.userId)).size).toBe(items.length)
      expect(await d().auditLog.count({ where: { tenantId: f3.tenantId, action: "ASSET_RECOVERY_FINAL_NOTICE_REMINDED", entityId: r.id } })).toBe(1)
    } finally { await d().user.update({ where: { id: creator }, data: { active: true } }) }
  }, 60_000)

  it("R2-c: inactive creator and no active admin => no marker, noRecipient counted, failed 0; once an admin is active the next run reminds", async () => {
    const r = await nca(f3, "2027-03-01")
    const creator = (await d().recovery.findUniqueOrThrow({ where: { id: r.id } })).createdById
    const admins = await d().user.findMany({ where: { tenantId: f3.tenantId, role: { in: ["ADMIN", "SUPER_ADMIN"] }, active: true }, select: { id: true } })
    await d().user.updateMany({ where: { id: { in: [creator, ...admins.map((a) => a.id)] } }, data: { active: false } })
    try {
      const run = await runRecoveryDeadlineSweep("2027-03-09")
      expect(run.failed).toBe(0)
      expect((run as { noRecipient?: number }).noRecipient).toBeGreaterThanOrEqual(1)
      expect(await bells(f3.tenantId, r.id)).toHaveLength(0)
      expect(await d().auditLog.count({ where: { tenantId: f3.tenantId, action: "ASSET_RECOVERY_FINAL_NOTICE_REMINDED", entityId: r.id } })).toBe(0)
    } finally { await d().user.updateMany({ where: { id: { in: [creator, ...admins.map((a) => a.id)] } }, data: { active: true } }) }
    await runRecoveryDeadlineSweep("2027-03-10")
    expect(await bells(f3.tenantId, r.id)).toHaveLength(1)
  }, 60_000)

  it("R2-d: a recovery that is no longer PROCEEDS_APPLIED at lock time is skipped (no bell, no marker)", async () => {
    const r = await nca(f3, "2027-04-01")
    await testSetup(d(), [`UPDATE "Recovery" SET "status" = 'LISTED', "chargesFrozenFrom" = '2027-04-01' WHERE "id" = $1`, r.id])
    await runRecoveryDeadlineSweep("2027-04-09")
    expect(await bells(f3.tenantId, r.id)).toHaveLength(0)
  }, 60_000)
})
