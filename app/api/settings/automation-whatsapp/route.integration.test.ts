/**
 * Real-Postgres proof of the automated WhatsApp reminders switch's route: off
 * by default, only an ADMIN or SUPER_ADMIN changes it, every change is audited
 * with the value it replaced, and an unchanged value writes nothing.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/settings/automation-whatsapp/route.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { PrismaClient, type UserRole } from "@prisma/client"

const token = randomUUID().replaceAll("-", "")
const tenantId = `tenant_awa_route_${token}`
const slug = `awa-route-${token}`
const emailOf = (id: string) => `${id}@test.invalid`

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }))
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { GET, PUT } from "./route"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe : describe.skip

suite("/api/settings/automation-whatsapp (real database)", () => {
  const db = new PrismaClient()
  const ids = { admin: `user_awa_admin_${token}`, manager: `user_awa_manager_${token}` }
  const signIn = (id: string, role: UserRole, extra: Record<string, unknown> = {}) => {
    h.session = { user: { id, email: emailOf(id), name: null, role, tenantId, totpVerified: true, tokenVersion: 0, ...extra } }
  }
  const request = (method: string, body?: unknown) => new NextRequest("http://localhost/api/settings/automation-whatsapp", {
    method, headers: { "content-type": "application/json", "x-tenant-slug": slug }, body: body === undefined ? undefined : JSON.stringify(body),
  })
  const put = (body: unknown) => PUT(request("PUT", body))
  const stored = async () => (await db.tenantConfig.findUniqueOrThrow({ where: { tenantId } })).automatedWhatsAppReminders
  const audits = () => db.auditLog.findMany({
    where: { tenantId, action: "AUTOMATED_WHATSAPP_REMINDERS_UPDATED" },
    orderBy: { createdAt: "asc" },
    select: { userId: true, entity: true, entityId: true, oldValue: true, newValue: true },
  })

  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug, name: "Automated WhatsApp Route Test" } })
    await db.tenantConfig.create({ data: { tenantId, requireStaffTotp: false } })
    const staff = (id: string, role: UserRole) =>
      ({ id, tenantId, role, email: emailOf(id), name: "Synthetic Staff", password: "not-a-login-credential" })
    await db.user.createMany({ data: [staff(ids.admin, "ADMIN"), staff(ids.manager, "BRANCH_MANAGER")] })
  })

  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.user.deleteMany({ where: { tenantId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("is off by default", async () => {
    signIn(ids.manager, "BRANCH_MANAGER")
    expect(await (await GET(request("GET"))).json()).toEqual({ enabled: false })
    expect(await stored()).toBe(false)
  })

  it("refuses a BRANCH_MANAGER and changes nothing", async () => {
    signIn(ids.manager, "BRANCH_MANAGER")
    expect((await put({ enabled: true })).status).toBe(403)
    expect(await stored()).toBe(false)
    expect(await audits()).toEqual([])
  })

  it("lets an ADMIN switch it on, audited with the value replaced", async () => {
    signIn(ids.admin, "ADMIN")
    const res = await put({ enabled: true })
    expect(await res.json()).toEqual({ ok: true, changed: true, enabled: true })
    expect(await stored()).toBe(true)
    expect(await audits()).toEqual([{
      userId: ids.admin, entity: "TenantConfig", entityId: tenantId,
      oldValue: { automatedWhatsAppReminders: false }, newValue: { automatedWhatsAppReminders: true },
    }])
  })

  it("writes and audits nothing when the value is unchanged", async () => {
    signIn(ids.admin, "ADMIN")
    expect(await (await put({ enabled: true })).json()).toEqual({ ok: true, changed: false, enabled: true })
    expect(await audits()).toHaveLength(1)
  })

  it("rejects a non-boolean body", async () => {
    signIn(ids.admin, "ADMIN")
    expect((await put({ enabled: "yes" })).status).toBe(400)
  })

  it("refuses a session without TOTP while the lender requires staff 2FA", async () => {
    await db.tenantConfig.update({ where: { tenantId }, data: { requireStaffTotp: true } })
    signIn(ids.admin, "ADMIN", { totpVerified: false })
    expect((await put({ enabled: false })).status).toBe(403)
    expect(await stored()).toBe(true)
  })
})
