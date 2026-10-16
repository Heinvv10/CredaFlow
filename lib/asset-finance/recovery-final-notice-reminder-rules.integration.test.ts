/**
 * The NCA final-notice reminder's rules (real migrated Postgres): a final
 * notice issued while the sweep waits on the loan lock cancels the reminder;
 * an inactive creator's reminder goes to the tenant's active ADMIN and
 * SUPER_ADMIN users, and with none of those nothing is marked, so the next run
 * tries again; the loan's status does not matter, the final notice is owed.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-final-notice-reminder-rules.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { testSetup } from "./lease-servicing.integration-fixture"
import { runRecoveryDeadlineSweep, type RecoveryDeadlineRun } from "./recovery-freeze-deadline"
import { ladderRecovery } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"

// The deal fixture imports staff routes, which import NextAuth; the sweep needs no session.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const t2 = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
let bare: RecoveryFixture
const d = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
// Frozen on Fri 2027-01-08: the 5th SA business day is Fri 2027-01-15.
const FROZEN = "2027-01-08"
const DUE = "2027-01-15"

async function due(f: RecoveryFixture) {
  const r = await ladderRecovery(d(), f, true, "PROCEEDS_APPLIED")
  await testSetup(d(), [`UPDATE "Recovery" SET "chargesFrozenFrom" = $1::date WHERE "id" = $2`, FROZEN, r.id])
  return r
}
const bells = (tenantId: string, id: string) => d().notification.findMany({ where: { tenantId, type: "RECOVERY_FINAL_NOTICE_DUE", entityId: id }, orderBy: { userId: "asc" } })
const markers = (tenantId: string, id: string) => d().auditLog.count({ where: { tenantId, action: "ASSET_RECOVERY_FINAL_NOTICE_REMINDED", entityId: id } })
const staff = async (f: RecoveryFixture, role: "ADMIN" | "SUPER_ADMIN", active = true) =>
  (await d().user.create({ data: { tenantId: f.tenantId, email: `${role.toLowerCase()}-${randomUUID().slice(0, 8)}@staff.invalid`, password: "x", role, active } })).id
const setActive = (id: string, active: boolean) => d().user.update({ where: { id }, data: { active } })

suite.sequential("NCA final-notice reminder rules (real Postgres)", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(d(), t)
    bare = await createRecoveryFixture(d(), t2)
  }, 180_000)

  afterAll(async () => {
    for (const tenant of [t, t2]) await cleanupRecoveryFixture(d(), recoveryFixtureTenantId(tenant)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("skips a recovery whose final notice is issued while the sweep waits for the loan lock", async () => {
    const r = await due(fx)
    let sweep: Promise<RecoveryDeadlineRun> | undefined
    await d().$transaction(async (tx) => {
      // Hold the loan lock, and issue the final notice in the same (still uncommitted) transaction.
      await tx.$queryRawUnsafe(`SELECT 1 FROM "Loan" WHERE "id" = $1 FOR UPDATE`, r.loan.loanId)
      await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica")
      await tx.$executeRawUnsafe(`UPDATE "Recovery" SET "status" = 'FINAL_NOTICE_ISSUED', "finalNoticeIssuedOn" = $1::date WHERE "id" = $2`, DUE, r.id)
      // The sweep's query still sees PROCEEDS_APPLIED; it then blocks on the loan lock.
      sweep = runRecoveryDeadlineSweep(DUE)
      const deadline = Date.now() + 30_000
      for (;;) {
        const [{ waiting }] = await d().$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_locks WHERE NOT granted`
        if (waiting > 0) break
        if (Date.now() > deadline) throw new Error("the sweep never waited for the loan lock")
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }, { timeout: 60_000 })
    expect(await sweep).toMatchObject({ ok: true, failed: 0 })
    expect(await bells(fx.tenantId, r.id)).toHaveLength(0)
    expect(await markers(fx.tenantId, r.id)).toBe(0)
  }, 120_000)

  it("bells the active ADMIN and SUPER_ADMIN users when the creator is inactive, never an inactive one", async () => {
    const admin = await staff(fx, "ADMIN")
    const superAdmin = await staff(fx, "SUPER_ADMIN")
    await staff(fx, "ADMIN", false)
    const r = await due(fx)
    await setActive(fx.officer, false)
    try {
      expect(await runRecoveryDeadlineSweep(DUE)).toMatchObject({ ok: true, failed: 0 })
    } finally {
      await setActive(fx.officer, true)
    }
    expect((await bells(fx.tenantId, r.id)).map((b) => b.userId)).toEqual([admin, superAdmin].sort())
    expect(await markers(fx.tenantId, r.id)).toBe(1)
  }, 120_000)

  it("with no active admin to tell, writes no marker, and the next run bells once an admin exists", async () => {
    const r = await due(bare)
    await setActive(bare.officer, false)
    try {
      const first = await runRecoveryDeadlineSweep(DUE)
      expect(first).toMatchObject({ ok: true, failed: 0 })
      expect(first.noRecipient).toBeGreaterThanOrEqual(1)
      expect(await bells(bare.tenantId, r.id)).toHaveLength(0)
      expect(await markers(bare.tenantId, r.id)).toBe(0)
      const admin = await staff(bare, "ADMIN")
      expect(await runRecoveryDeadlineSweep("2027-01-18")).toMatchObject({ ok: true, failed: 0 })
      expect((await bells(bare.tenantId, r.id)).map((b) => b.userId)).toEqual([admin])
      expect(await markers(bare.tenantId, r.id)).toBe(1)
    } finally {
      await setActive(bare.officer, true)
    }
  }, 120_000)

  it.each(["COMPLETED", "WRITTEN_OFF"])("still bells when the loan is %s: the final notice is owed", async (status) => {
    const r = await due(fx)
    await testSetup(d(), [`UPDATE "Loan" SET "status" = $1::"LoanStatus" WHERE "id" = $2`, status, r.loan.loanId])
    expect(await runRecoveryDeadlineSweep(DUE)).toMatchObject({ ok: true, failed: 0 })
    expect((await bells(fx.tenantId, r.id)).map((b) => b.userId)).toEqual([fx.officer])
    expect(await markers(fx.tenantId, r.id)).toBe(1)
  }, 120_000)
})
