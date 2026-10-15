/**
 * Real-Postgres proof of the operator console (W1): provisioning makes a
 * lender whose admin can set a password and sign in; OPERATOR_SUPPORT cannot
 * provision or suspend; suspension stops the lender's staff signing in and
 * ends their sessions; the lender's Support access API grants and revokes;
 * an operator user reads borrower rows only through an active grant.
 *
 * Stubbed: NextAuth itself (its config is captured so authorize() runs for
 * real), the request headers, and the platform mailer. Everything else is real.
 *
 *   RUN_OPERATOR_CONSOLE_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/operator/console.integration.test.ts
 */
import bcrypt from "bcryptjs"
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  config: null as null | { providers: Array<{ authorize: (c: Record<string, string>, r: Request) => Promise<unknown> }> },
  session: null as null | { user: Record<string, unknown> },
  headers: {} as Record<string, string>,
  mail: [] as Array<{ to: string; html: string }>,
}))
vi.mock("next-auth", () => ({
  default: (config: typeof m.config) => {
    m.config = config
    return { handlers: {}, auth: async () => m.session, signIn: vi.fn(), signOut: vi.fn() }
  },
  CredentialsSignin: class extends Error { code = "credentials" },
}))
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }))
vi.mock("next/headers", async (orig) => ({ ...(await orig<typeof import("next/headers")>()), headers: async () => new Headers(m.headers) }))
vi.mock("@/lib/email", () => ({ sendEmail: async (o: { to: string; html: string }) => { m.mail.push(o); return { ok: true, messageId: "it" } } }))

import { revalidatePrincipal } from "@/lib/auth"
import { POST as provision } from "@/app/api/operator/lenders/route"
import { POST as setStatus } from "@/app/api/operator/lenders/[id]/status/route"
import { POST as grantApi } from "@/app/api/settings/support-access/route"
import { POST as revokeApi } from "@/app/api/settings/support-access/[id]/revoke/route"
import { POST as resetPassword } from "@/app/api/auth/reset-password/route"
import { openLenderAsSupport } from "./console/support-view"
import { listOperatorLenders } from "./console/lenders"
import { listSupportAudit } from "./console/grants"
import { validFile } from "@/scripts/lender/tenant-config.test-helpers"
import { createIsolationFixture, dropIsolationFixture, type IsolationFixture } from "../tenant-isolation.integration-fixture"

const suite = process.env.RUN_OPERATOR_CONSOLE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const PASSWORD = "synthetic-Passw0rd!"
let f: IsolationFixture
let adminId = ""
let provisioned = ""

const operatorSession = (id: string, role: "OPERATOR_ADMIN" | "OPERATOR_SUPPORT", operatorId = f.operatorId) => ({
  user: { id, email: `${role}-${f.token}@op-it.invalid`, name: role, role, operatorId, tenantId: null, totpVerified: true, totpEnrolmentRequired: false },
})
const lenderAdmin = (totpVerified = true) => ({
  user: { id: f.a.adminId, email: `admin-a-${f.token}@iso-it.invalid`, name: "Admin a", role: "ADMIN", tenantId: f.a.tenantId, totpVerified, totpEnrolmentRequired: false, tokenVersion: 0 },
})
function post(path: string, body: unknown, extra: Record<string, string> = {}) {
  m.headers = { host: "localhost", "x-cf-request-method": "POST", "x-cf-request-id": randomUUID(), ...extra }
  return new NextRequest(`http://localhost${path}`, { method: "POST", headers: m.headers, body: JSON.stringify(body) })
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const staffSignIn = (email: string) => m.config!.providers[0].authorize(
  { email, password: PASSWORD, loginType: "staff" }, new Request("http://localhost/api/auth/callback/credentials", { headers: { host: "localhost" } }),
)
const audit = (action: string, where: Record<string, unknown> = {}) => db.auditLog.findMany({ where: { action, ...where } })

suite("operator console — real database", () => {
  beforeAll(async () => {
    f = await createIsolationFixture(db)
    const admin = await db.user.create({
      data: { operatorId: f.operatorId, email: `opadmin-${f.token}@op-it.invalid`, name: "Op Admin", role: "OPERATOR_ADMIN", password: "x" },
    })
    adminId = admin.id
    await db.user.update({ where: { id: f.a.adminId }, data: { password: bcrypt.hashSync(PASSWORD, 4) } })
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000")
  }, 60_000)

  afterAll(async () => {
    const tenants = [f.a.tenantId, f.b.tenantId, ...(provisioned ? [provisioned] : [])]
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.$executeRawUnsafe(`DELETE FROM "DocumentTemplateVersion" WHERE "templateId" IN (SELECT "id" FROM "DocumentTemplate" WHERE "tenantId" = ANY($1))`, tenants),
      ...["DocumentTemplate", "MessageTemplate", "LoginLog", "AuditLog", "TenantSupportGrant", "User", "TenantConfig"]
        .map((t) => db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = ANY($1)`, provisioned ? [provisioned, f.a.tenantId] : [f.a.tenantId])),
      db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "userId" = $1`, adminId),
      db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = $1`, adminId),
      db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = $1`, provisioned || "none"),
      db.$executeRawUnsafe(`DELETE FROM "FailedLoginAttempt" WHERE "email" LIKE $1`, `%${f.token}%`),
    ])
    await dropIsolationFixture(db, f)
    await db.$disconnect()
  })

  beforeEach(() => {
    m.mail = []
    m.session = operatorSession(adminId, "OPERATOR_ADMIN")
  })

  it("provisions a working lender under the operator; its first admin sets a password and signs in", async () => {
    const slug = `op-it-${f.token}`
    const email = `first-admin-${f.token}@op-it.invalid`
    const res = await provision(post("/api/operator/lenders", { ...validFile(), slug, admin: { email, name: "First Admin" } }))
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(body).toMatchObject({ inviteSent: true })
    provisioned = body.tenantId

    const tenant = await db.tenant.findUniqueOrThrow({ where: { id: provisioned }, include: { config: true } })
    expect(tenant).toMatchObject({ slug, status: "ACTIVE", operatorId: f.operatorId })
    expect(tenant.config?.brandName).toBe("Staging Lender")
    expect(await db.documentTemplate.count({ where: { tenantId: provisioned } })).toBeGreaterThan(0)
    expect(await db.messageTemplate.count({ where: { tenantId: provisioned } })).toBeGreaterThan(0)
    expect(await audit("TENANT_CREATED", { tenantId: provisioned })).toEqual([expect.objectContaining({ userId: adminId })])
    expect(await audit("LENDER_ADMIN_INVITED", { tenantId: provisioned })).toHaveLength(1)

    const admin = await db.user.findUniqueOrThrow({ where: { email } })
    expect(admin).toMatchObject({ role: "SUPER_ADMIN", tenantId: provisioned, operatorId: null })
    // The link went to the admin; the operator's response never carried it.
    expect(m.mail).toHaveLength(1)
    expect(m.mail[0].to).toBe(email)
    expect(m.mail[0].html).toContain(`/reset-password?token=${admin.resetToken}`)
    expect(JSON.stringify(body)).not.toContain(admin.resetToken!)

    const set = await resetPassword(post("/api/auth/reset-password", { token: admin.resetToken, password: PASSWORD }))
    expect(set.status).toBe(200)
    await expect(staffSignIn(email)).resolves.toMatchObject({ id: admin.id, tenantId: provisioned })
  }, 60_000)

  it("refuses OPERATOR_SUPPORT provisioning or suspending, and touches nothing", async () => {
    m.session = operatorSession(f.operatorUserId, "OPERATOR_SUPPORT")
    const slug = `op-it-support-${f.token}`
    expect((await provision(post("/api/operator/lenders", { ...validFile(), slug, admin: { email: `x-${f.token}@op-it.invalid`, name: "X" } }))).status).toBe(403)
    expect(await db.tenant.findUnique({ where: { slug } })).toBeNull()
    expect((await setStatus(post("/x", { status: "SUSPENDED", reason: "no" }), ctx(f.a.tenantId))).status).toBe(403)
    expect((await db.tenant.findUniqueOrThrow({ where: { id: f.a.tenantId } })).status).toBe("ACTIVE")
  })

  it("suspension stops the lender's staff signing in and ends their sessions; reactivation restores both", async () => {
    const email = `admin-a-${f.token}@iso-it.invalid`
    await expect(staffSignIn(email)).resolves.toMatchObject({ id: f.a.adminId })

    const res = await setStatus(post("/x", { status: "SUSPENDED", reason: "Unpaid invoice (synthetic)" }), ctx(f.a.tenantId))
    expect(res.status).toBe(200)
    expect(await audit("TENANT_SUSPENDED", { tenantId: f.a.tenantId })).toEqual([expect.objectContaining({ userId: adminId })])
    await expect(staffSignIn(email)).resolves.toBeNull()
    expect(await db.failedLoginAttempt.findFirst({ where: { email, reason: "tenant_suspended" } })).not.toBeNull()
    expect(await revalidatePrincipal(f.a.adminId, 0)).toBeNull()

    expect((await setStatus(post("/x", { status: "ACTIVE", reason: "Paid" }), ctx(f.a.tenantId))).status).toBe(200)
    await expect(staffSignIn(email)).resolves.toMatchObject({ id: f.a.adminId })
    expect(await revalidatePrincipal(f.a.adminId, 0)).toMatchObject({ tenantId: f.a.tenantId })
  })

  it("an operator cannot act on a lender another operator runs", async () => {
    m.session = operatorSession(adminId, "OPERATOR_ADMIN", f.otherOperatorId)
    expect((await setStatus(post("/x", { status: "SUSPENDED", reason: "x" }), ctx(f.a.tenantId))).status).toBe(404)
  })

  it("grant lifecycle from the lender's Support access API; borrower rows only through an active grant", async () => {
    const support = operatorSession(f.operatorUserId, "OPERATOR_SUPPORT").user as never
    const open = (tenantId: string) => {
      m.headers = { "x-cf-request-method": "GET", "x-cf-request-id": randomUUID() }
      return openLenderAsSupport(support, tenantId)
    }
    const lender = { "x-tenant-slug": f.a.slug }

    // No grant: counts only, and the open is refused and audited.
    const listed = await listOperatorLenders(f.operatorId)
    expect(listed.find((l) => l.id === f.a.tenantId)).toMatchObject({ clients: 1, activeLoans: 1 })
    expect(JSON.stringify(listed)).not.toContain("Synthetic")
    expect(await open(f.a.tenantId)).toEqual({ allowed: false, reason: "no_active_grant" })

    m.session = lenderAdmin(false)
    const noTotp = await grantApi(post("/api/settings/support-access", { operatorUserId: f.operatorUserId, durationHours: 24, reason: "Ticket 7" }, lender))
    expect(noTotp.status).toBe(403)
    expect(await audit("SUPPORT_ACCESS_GRANT_REFUSED", { tenantId: f.a.tenantId })).not.toHaveLength(0)
    m.session = lenderAdmin()
    expect((await grantApi(post("/api/settings/support-access", { operatorUserId: f.operatorUserId, durationHours: 169, reason: "Too long" }, lender))).status).toBe(400)
    const granted = await grantApi(post("/api/settings/support-access", { operatorUserId: f.operatorUserId, durationHours: 24, reason: "Ticket 7" }, lender))
    expect(granted.status).toBe(201)
    const grantId = (await granted.json()).id as string

    const view = await open(f.a.tenantId)
    expect(view.allowed).toBe(true)
    if (view.allowed) {
      expect(view.data.clients.map((c) => c.id)).toEqual([f.a.clientId])
      expect(view.data.clients[0].idNumber).toMatch(/^•+\d{4}$/)
    }
    expect(await open(f.b.tenantId)).toEqual({ allowed: false, reason: "no_active_grant" })
    expect((await listSupportAudit(f.a.tenantId)).map((r) => r.action)).toContain("SUPPORT_ACCESS_USED")

    m.session = lenderAdmin()
    expect((await revokeApi(post("/x", {}, lender), ctx(grantId))).status).toBe(200)
    expect((await revokeApi(post("/x", {}, lender), ctx(grantId))).status).toBe(404)
    expect(await audit("SUPPORT_ACCESS_REVOKED", { tenantId: f.a.tenantId, entityId: grantId })).toHaveLength(1)
    expect(await open(f.a.tenantId)).toEqual({ allowed: false, reason: "no_active_grant" })
  })
})
