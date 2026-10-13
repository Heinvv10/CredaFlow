/**
 * Real-Postgres proof of the staff two-factor policy: the column default
 * (on, for any row that does not say otherwise), the audited write, and the
 * sign-out of unenrolled staff that comes with a change.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/security/staff-totp-policy.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { PrismaClient } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { applyStaffTotpRequired, getStaffTotpPolicyState, isStaffTotpRequired } from "./staff-totp-policy"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_totp_policy_${token}`
const bareTenantId = `tenant_totp_policy_bare_${token}`
const ids = {
  actor: `user_tp_actor_${token}`,
  unenrolled: `user_tp_unenrolled_${token}`,
  enrolled: `user_tp_enrolled_${token}`,
  other: `user_tp_other_tenant_${token}`,
}

suite("staff two-factor policy (real database)", () => {
  const db = new PrismaClient()

  beforeAll(async () => {
    await db.tenant.createMany({
      data: [
        { id: tenantId, slug: `totp-policy-${token}`, name: "Totp Policy Integration Test" },
        { id: bareTenantId, slug: `totp-policy-bare-${token}`, name: "Totp Policy Bare Integration Test" },
      ],
    })
    await db.tenantConfig.create({ data: { tenantId } })
    const staff = (id: string, tenant: string, extra: Record<string, unknown> = {}) =>
      ({ id, tenantId: tenant, email: `${id}@test.invalid`, name: "Synthetic Staff", password: "not-a-login-credential", role: "ADMIN" as const, ...extra })
    await db.user.createMany({
      data: [
        staff(ids.actor, tenantId, { role: "SUPER_ADMIN", totpEnabled: true, totpSecret: "SYNTHETICSECRET" }),
        staff(ids.unenrolled, tenantId),
        staff(ids.enrolled, tenantId, { totpEnabled: true, totpSecret: "SYNTHETICSECRET" }),
        staff(ids.other, bareTenantId),
      ],
    })
  })

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { tenantId: { in: [tenantId, bareTenantId] } } })
    await db.user.deleteMany({ where: { id: { in: Object.values(ids) } } })
    await db.tenantConfig.deleteMany({ where: { tenantId: { in: [tenantId, bareTenantId] } } })
    await db.tenant.deleteMany({ where: { id: { in: [tenantId, bareTenantId] } } })
    await db.$disconnect()
  })

  const version = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { tokenVersion: true } })).tokenVersion
  const set = (required: boolean) => prisma.$transaction((tx) =>
    applyStaffTotpRequired(tx, { tenantId, actor: { id: ids.actor, email: `${ids.actor}@test.invalid` }, required }))

  it("is on for a config row created without a value, and for a tenant with no config row", async () => {
    expect((await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } })).requireStaffTotp).toBe(true)
    expect(await isStaffTotpRequired(tenantId)).toBe(true)
    expect(await isStaffTotpRequired(bareTenantId)).toBe(true)
  })

  it("the column is NOT NULL with default true (so every existing row came out on)", async () => {
    const [col] = await db.$queryRaw<Array<{ is_nullable: string; column_default: string }>>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'TenantConfig' AND column_name = 'requireStaffTotp'`
    expect(col).toEqual({ is_nullable: "NO", column_default: "true" })
  })

  it("switching off records old value, new value and actor, and signs out only this tenant's unenrolled staff", async () => {
    const before = { unenrolled: await version(ids.unenrolled), enrolled: await version(ids.enrolled), actor: await version(ids.actor), other: await version(ids.other) }
    expect(await set(false)).toEqual({ changed: true, required: false, signedOut: 1 })

    expect(await isStaffTotpRequired(tenantId)).toBe(false)
    expect(await version(ids.unenrolled)).toBe(before.unenrolled + 1)
    expect(await version(ids.enrolled)).toBe(before.enrolled)
    expect(await version(ids.actor)).toBe(before.actor)
    expect(await version(ids.other)).toBe(before.other)

    const rows = await db.auditLog.findMany({ where: { tenantId, action: "STAFF_TOTP_POLICY_UPDATED" } })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      userId: ids.actor, userEmail: `${ids.actor}@test.invalid`, entity: "TenantConfig", entityId: tenantId,
      oldValue: { requireStaffTotp: true }, newValue: { requireStaffTotp: false, signedOutUsers: 1 },
    })
  })

  it("an unchanged value writes no audit row and signs nobody out", async () => {
    const before = await version(ids.unenrolled)
    expect(await set(false)).toEqual({ changed: false, required: false, signedOut: 0 })
    expect(await version(ids.unenrolled)).toBe(before)
    expect(await db.auditLog.count({ where: { tenantId, action: "STAFF_TOTP_POLICY_UPDATED" } })).toBe(1)
  })

  it("switching on writes a second audit row, and the page state names who changed it last", async () => {
    expect(await set(true)).toMatchObject({ changed: true, required: true })
    const state = await getStaffTotpPolicyState(tenantId)
    expect(state.required).toBe(true)
    expect(state.lastChange?.byEmail).toBe(`${ids.actor}@test.invalid`)
    expect(await db.auditLog.count({ where: { tenantId, action: "STAFF_TOTP_POLICY_UPDATED" } })).toBe(2)
  })

  // With no config row there is nothing to lock: two first switches would both
  // read "on", both upsert, and both audit "on -> off" (or one fail on the
  // tenantId unique key and answer 500). They must serialise instead.
  it("serialises two concurrent first switches for a tenant with no config row: no error, one change", async () => {
    const raceTenant = `tenant_totp_policy_race_${token}`
    await db.tenant.create({ data: { id: raceTenant, slug: `totp-policy-race-${token}`, name: "Totp Policy Race Integration Test" } })
    try {
      const flip = () => prisma.$transaction((tx) =>
        applyStaffTotpRequired(tx, { tenantId: raceTenant, actor: { id: ids.actor, email: "a@test.invalid" }, required: false }))
      const results = await Promise.allSettled([flip(), flip(), flip()])
      expect(results.map((r) => r.status)).toEqual(["fulfilled", "fulfilled", "fulfilled"])
      const changed = results.map((r) => (r as PromiseFulfilledResult<{ changed: boolean }>).value.changed)
      expect(changed.filter(Boolean)).toHaveLength(1)
      expect(await db.auditLog.count({ where: { tenantId: raceTenant, action: "STAFF_TOTP_POLICY_UPDATED" } })).toBe(1)
      expect(await isStaffTotpRequired(raceTenant)).toBe(false)
    } finally {
      await db.auditLog.deleteMany({ where: { tenantId: raceTenant } })
      await db.tenantConfig.deleteMany({ where: { tenantId: raceTenant } })
      await db.tenant.deleteMany({ where: { id: raceTenant } })
    }
  })

  it("creates the config row when the tenant has none", async () => {
    const result = await prisma.$transaction((tx) =>
      applyStaffTotpRequired(tx, { tenantId: bareTenantId, actor: { id: ids.actor, email: "a@test.invalid" }, required: false }))
    expect(result.changed).toBe(true)
    expect(await isStaffTotpRequired(bareTenantId)).toBe(false)
  })
})
