/**
 * Real-Postgres proof of the segregation-of-duties setting's route: only an
 * ADMIN or SUPER_ADMIN of the tenant changes it, every change is audited with
 * the value it replaced, and an unchanged value writes nothing.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/settings/segregation-of-duties/route.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient, type UserRole } from "@prisma/client"

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_sod_route_${token}`
const slug = `sod-route-${token}`
const emailOf = (id: string) => `${id}@test.invalid`

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { PUT } from "./route"
import { purgeAuditRowsForTest } from "@/lib/audit/audit-rows.test-helpers"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("PUT /api/settings/segregation-of-duties (real database)", () => {
  const db = new PrismaClient()
  const ids = {
    admin: `user_sod_admin_${token}`,
    superAdmin: `user_sod_super_${token}`,
    manager: `user_sod_manager_${token}`,
    loanAdmin: `user_sod_loan_admin_${token}`,
  }
  const signIn = (id: string, role: UserRole, extra: Record<string, unknown> = {}) => {
    h.session = { user: { id, email: emailOf(id), name: null, role, tenantId, totpVerified: true, tokenVersion: 0, ...extra } }
  }
  const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/settings/segregation-of-duties", {
    method: "PUT", headers: { "content-type": "application/json", "x-tenant-slug": slug }, body: JSON.stringify(body),
  }))
  const stored = async () => (await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } })).requireSegregationOfDuties
  const audits = () => db.auditLog.findMany({
    where: { tenantId, action: "SEGREGATION_OF_DUTIES_POLICY_UPDATED" },
    orderBy: { createdAt: "asc" },
    select: { userId: true, entity: true, entityId: true, oldValue: true, newValue: true },
  })

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug, name: "Segregation Of Duties Route Test" } })
    await db.tenantConfig.create({ data: { tenantId, requireStaffTotp: false } })
    const staff = (id: string, role: UserRole) =>
      ({ id, tenantId, role, email: emailOf(id), name: "Synthetic Staff", password: "not-a-login-credential" })
    await db.user.createMany({
      data: [
        staff(ids.admin, "ADMIN"),
        staff(ids.superAdmin, "SUPER_ADMIN"),
        staff(ids.manager, "BRANCH_MANAGER"),
        staff(ids.loanAdmin, "LOAN_ADMIN"),
      ],
    })
  })

  afterAll(async () => {
    await purgeAuditRowsForTest(db, { tenantId })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("is on by default", async () => {
    expect(await stored()).toBe(true)
  })

  it.each([
    ["BRANCH_MANAGER", "manager"],
    ["LOAN_ADMIN", "loanAdmin"],
  ] as const)("refuses a %s and changes nothing", async (role, key) => {
    signIn(ids[key], role)
    expect((await put({ requireSegregationOfDuties: false })).status).toBe(403)
    expect(await stored()).toBe(true)
    expect(await audits()).toEqual([])
  })

  it("lets an ADMIN turn it off, audited with the value replaced", async () => {
    signIn(ids.admin, "ADMIN")
    const res = await put({ requireSegregationOfDuties: false })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, changed: true, requireSegregationOfDuties: false })
    expect(await stored()).toBe(false)
    expect(await audits()).toEqual([{
      userId: ids.admin, entity: "TenantConfig", entityId: tenantId,
      oldValue: { requireSegregationOfDuties: true }, newValue: { requireSegregationOfDuties: false },
    }])
  })

  it("writes and audits nothing when the value is unchanged", async () => {
    signIn(ids.admin, "ADMIN")
    expect(await (await put({ requireSegregationOfDuties: false })).json())
      .toEqual({ ok: true, changed: false, requireSegregationOfDuties: false })
    expect(await audits()).toHaveLength(1)
  })

  it("lets a SUPER_ADMIN turn it back on, audited", async () => {
    signIn(ids.superAdmin, "SUPER_ADMIN")
    expect((await put({ requireSegregationOfDuties: true })).status).toBe(200)
    expect(await stored()).toBe(true)
    expect((await audits()).at(-1)).toEqual({
      userId: ids.superAdmin, entity: "TenantConfig", entityId: tenantId,
      oldValue: { requireSegregationOfDuties: false }, newValue: { requireSegregationOfDuties: true },
    })
  })

  it("refuses a session without TOTP while the lender requires staff 2FA", async () => {
    await db.tenantConfig.update({ where: { tenantId }, data: { requireStaffTotp: true } })
    signIn(ids.admin, "ADMIN", { totpVerified: false })
    expect((await put({ requireSegregationOfDuties: false })).status).toBe(403)
    expect(await stored()).toBe(true)
    await db.tenantConfig.update({ where: { tenantId }, data: { requireStaffTotp: false } })
  })

  // Breaker review of #140: switching the control off needs TOTP whatever the
  // lender's 2FA policy (here off).
  it("refuses to turn it off from a session without TOTP even when the lender does not require 2FA", async () => {
    signIn(ids.admin, "ADMIN", { totpVerified: false })
    const res = await put({ requireSegregationOfDuties: false })
    expect(res.status).toBe(403)
    expect((await res.json()).error).toMatch(/two-factor/)
    expect(await stored()).toBe(true)
  })

  it("lets a TOTP-free demo session turn it off (DEMO_MODE + DEMO_CLEAR_STAFF_TOTP)", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    vi.stubEnv("DEMO_CLEAR_STAFF_TOTP", "true")
    signIn(ids.admin, "ADMIN", { totpVerified: false })
    const res = await put({ requireSegregationOfDuties: false })
    expect(await res.json()).toMatchObject({ ok: true })
    vi.unstubAllEnvs()
    expect(await stored()).toBe(false)
    signIn(ids.admin, "ADMIN")
    expect((await put({ requireSegregationOfDuties: true })).status).toBe(200)
  })

  it("re-checks the role on the locked row: a session still claiming ADMIN after a demotion is refused", async () => {
    await db.user.update({ where: { id: ids.manager }, data: { role: "BRANCH_MANAGER" } })
    signIn(ids.manager, "ADMIN")
    expect((await put({ requireSegregationOfDuties: false })).status).toBe(403)
    expect(await stored()).toBe(true)
  })

  it.each([undefined, null, "false", 0])("refuses requireSegregationOfDuties = %j with 400", async (value) => {
    signIn(ids.admin, "ADMIN")
    expect((await put({ requireSegregationOfDuties: value })).status).toBe(400)
  })
})
