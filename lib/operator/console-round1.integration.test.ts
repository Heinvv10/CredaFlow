/**
 * PR #91 round 1, against real Postgres: provisioning cannot take another
 * host (B1); email checks are case-insensitive (B2) and say nothing about
 * other operators' or lenders' accounts (S-L1); a support grant does not open
 * a suspended lender (B3); the operator's lender-admin reset is rate-limited,
 * leaves a fresh self-service link alone and tells the other admins (S-L2);
 * an OPERATOR_ADMIN can reset another operator user's 2FA and re-invite a
 * deactivated one (S-L3).
 *
 *   RUN_OPERATOR_CONSOLE_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/operator/console-round1.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  headers: {} as Record<string, string>,
  mail: [] as Array<{ to: string; subject: string; html: string }>,
}))
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: async () => m.session, signIn: vi.fn(), signOut: vi.fn() }),
  CredentialsSignin: class extends Error {},
}))
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }))
vi.mock("next/headers", async (orig) => ({ ...(await orig<typeof import("next/headers")>()), headers: async () => new Headers(m.headers) }))
vi.mock("@/lib/email", () => ({ sendEmail: async (o: { to: string; subject: string; html: string }) => { m.mail.push(o); return { ok: true, messageId: "it" } } }))

import { POST as provision } from "@/app/api/operator/lenders/route"
import { POST as adminReset } from "@/app/api/operator/lenders/[id]/admin-reset/route"
import { POST as invite } from "@/app/api/operator/users/route"
import { POST as deactivate } from "@/app/api/operator/users/[id]/deactivate/route"
import { POST as totpReset } from "@/app/api/operator/users/[id]/totp-reset/route"
import { grantSupportAccess } from "./support-grants"
import { openLenderAsSupport } from "./console/support-view"
import { validFile } from "@/scripts/lender/tenant-config.test-helpers"
import { createIsolationFixture, dropIsolationFixture, type IsolationFixture } from "../tenant-isolation.integration-fixture"

const suite = process.env.RUN_OPERATOR_CONSOLE_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
let f: IsolationFixture
let adminId = ""
const extraUsers: string[] = []

const asAdmin = () => ({ user: { id: adminId, email: `r1admin-${f.token}@op-it.invalid`, name: "Op Admin", role: "OPERATOR_ADMIN", operatorId: f.operatorId, tenantId: null, totpVerified: true, totpEnrolmentRequired: false } })
function post(body: unknown) {
  m.headers = { host: "localhost", "x-cf-request-method": "POST", "x-cf-request-id": randomUUID() }
  return new NextRequest("http://localhost/api/operator/x", { method: "POST", headers: m.headers, body: JSON.stringify(body) })
}
const ctx = (id: string) => ({ params: Promise.resolve({ id }) })
const lenderBody = (over: Record<string, unknown>) => ({ ...validFile(), slug: `r1-${f.token}-${Object.keys(over).length}`, admin: { email: `new-${randomUUID()}@op-it.invalid`, name: "New" }, ...over })
const statusAndBody = async (res: Response) => ({ status: res.status, body: await res.json() })

suite("operator console — PR #91 round 1, real database", () => {
  beforeAll(async () => {
    f = await createIsolationFixture(db)
    adminId = (await db.user.create({ data: { operatorId: f.operatorId, email: `r1admin-${f.token}@op-it.invalid`, name: "Op Admin", role: "OPERATOR_ADMIN", password: "x" } })).id
    vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000")
    vi.stubEnv("OPERATOR_APP_HOST", `console-${f.token}.op-it.invalid`)
  }, 60_000)

  afterAll(async () => {
    const tenants = [f.a.tenantId, f.b.tenantId]
    // Lenders this suite may have provisioned (only if a refusal regressed).
    const made = (await db.tenant.findMany({ where: { slug: { startsWith: `r1-${f.token}` } }, select: { id: true } })).map((t) => t.id)
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.$executeRawUnsafe(`DELETE FROM "DocumentTemplateVersion" WHERE "templateId" IN (SELECT "id" FROM "DocumentTemplate" WHERE "tenantId" = ANY($1))`, made),
      ...["DocumentTemplate", "MessageTemplate", "AuditLog", "User", "TenantConfig"]
        .map((t) => db.$executeRawUnsafe(`DELETE FROM "${t}" WHERE "tenantId" = ANY($1)`, made)),
      db.$executeRawUnsafe(`DELETE FROM "Tenant" WHERE "id" = ANY($1)`, made),
      db.$executeRawUnsafe(`DELETE FROM "AuditLog" WHERE "userId" = ANY($1) OR "tenantId" = ANY($2)`, [adminId, ...extraUsers], tenants),
      db.$executeRawUnsafe(`DELETE FROM "User" WHERE "id" = ANY($1)`, [adminId, ...extraUsers]),
    ])
    await dropIsolationFixture(db, f)
    await db.$disconnect()
  })

  beforeEach(() => {
    m.mail = []
    m.session = asAdmin()
  })

  it("B1: refuses a new lender's domain that is the console host or another lender's subdomain host; stores it normalised", async () => {
    for (const domain of [`console-${f.token}.op-it.invalid`, `${f.a.slug}.lenders.example`]) {
      const res = await statusAndBody(await provision(post(lenderBody({ domain }))))
      expect(res.status, domain).toBe(422)
    }
    expect(await db.tenant.count({ where: { slug: { startsWith: `r1-${f.token}` } } })).toBe(0)
  })

  it("B2 + S-L1: an existing email in another case is refused, with one generic answer for every case", async () => {
    const lenderAdminEmail = `admin-a-${f.token}@iso-it.invalid`.toUpperCase()
    const provisioned = await statusAndBody(await provision(post(lenderBody({ admin: { email: lenderAdminEmail, name: "X" } }))))
    const invited = await statusAndBody(await invite(post({ email: lenderAdminEmail, name: "X", role: "OPERATOR_SUPPORT" })))
    expect(provisioned.status).toBe(409)
    expect(invited.status).toBe(409)
    expect(provisioned.body.error).toBe(invited.body.error)
    expect(provisioned.body.error).not.toMatch(/exist/i)

    // A row stored in mixed case (older writers did not lower-case): the
    // lower-cased request must still find it, or a second account is made.
    const mixed = await db.user.create({ data: { tenantId: f.b.tenantId, email: `Mixed.Case-${f.token}@ISO-IT.invalid`, name: "M", role: "CREDIT_OFFICER", password: "x" } })
    extraUsers.push(mixed.id)
    const lower = mixed.email.toLowerCase()
    expect((await provision(post(lenderBody({ slug: `r1-${f.token}-mixed`, admin: { email: lower, name: "X" } })))).status).toBe(409)
    expect((await invite(post({ email: lower, name: "X", role: "OPERATOR_SUPPORT" }))).status).toBe(409)
    expect(await db.user.count({ where: { email: { equals: lower, mode: "insensitive" } } })).toBe(1)
  })

  it("S-L3: re-inviting a deactivated operator user reactivates them with a fresh invite and no 2FA", async () => {
    const email = `reinvite-${f.token}@op-it.invalid`
    const first = await statusAndBody(await invite(post({ email, name: "Re", role: "OPERATOR_SUPPORT" })))
    expect(first.status).toBe(201)
    extraUsers.push(first.body.userId)
    await db.user.update({ where: { id: first.body.userId }, data: { totpSecret: "JBSWY3DPEHPK3PXP", totpEnabled: true } })
    expect((await deactivate(post({}), ctx(first.body.userId))).status).toBe(200)
    const again = await statusAndBody(await invite(post({ email: email.toUpperCase(), name: "Re", role: "OPERATOR_SUPPORT" })))
    expect(again.status).toBe(201)
    expect(again.body.userId).toBe(first.body.userId)
    const row = await db.user.findUniqueOrThrow({ where: { id: first.body.userId } })
    expect(row).toMatchObject({ active: true, totpEnabled: false, totpSecret: null })
    expect(await db.auditLog.count({ where: { action: "OPERATOR_USER_REACTIVATED", entityId: row.id } })).toBe(1)
    // An active member of the operator: said plainly, within the operator.
    expect((await invite(post({ email, name: "Re", role: "OPERATOR_SUPPORT" }))).status).toBe(409)
  })

  it("S-L3: an OPERATOR_ADMIN resets another operator user's 2FA (audited); never their own, never another operator's", async () => {
    await db.user.update({ where: { id: f.operatorUserId }, data: { totpSecret: "JBSWY3DPEHPK3PXP", totpEnabled: true } })
    const before = await db.user.findUniqueOrThrow({ where: { id: f.operatorUserId } })
    expect((await totpReset(post({}), ctx(f.operatorUserId))).status).toBe(200)
    const after = await db.user.findUniqueOrThrow({ where: { id: f.operatorUserId } })
    expect(after).toMatchObject({ totpEnabled: false, totpSecret: null, tokenVersion: before.tokenVersion + 1 })
    expect(await db.auditLog.count({ where: { action: "OPERATOR_USER_TOTP_RESET", entityId: f.operatorUserId } })).toBe(1)
    expect((await totpReset(post({}), ctx(adminId))).status).toBe(409)
    m.session = { user: { ...asAdmin().user, operatorId: f.otherOperatorId } }
    expect((await totpReset(post({}), ctx(f.operatorUserId))).status).toBe(404)
  })

  it("B3: a support grant does not open a suspended lender", async () => {
    await db.user.update({ where: { id: f.operatorUserId }, data: { active: true } })
    await grantSupportAccess({
      tenantId: f.b.tenantId, actor: { id: f.b.adminId, email: "admin-b@iso-it.invalid", role: "ADMIN", tenantId: f.b.tenantId, totpVerified: true },
      operatorUserId: f.operatorUserId, expiresAt: new Date(Date.now() + 3_600_000), reason: "Ticket R1",
    })
    const support = { id: f.operatorUserId, email: "s@op-it.invalid", name: null, role: "OPERATOR_SUPPORT" as const, operatorId: f.operatorId, totpVerified: true as const }
    m.headers = { "x-cf-request-method": "GET", "x-cf-request-id": randomUUID() }
    expect((await openLenderAsSupport(support, f.b.tenantId)).allowed).toBe(true)
    await db.tenant.update({ where: { id: f.b.tenantId }, data: { status: "SUSPENDED" } })
    m.headers = { "x-cf-request-method": "GET", "x-cf-request-id": randomUUID() }
    expect(await openLenderAsSupport(support, f.b.tenantId)).toEqual({ allowed: false, reason: "tenant_inactive" })
    await db.tenant.update({ where: { id: f.b.tenantId }, data: { status: "ACTIVE" } })
  })

  it("S-L2: lender-admin reset is once an hour, spares a fresh self-service link, and tells the other admins", async () => {
    const other = await db.user.create({ data: { tenantId: f.a.tenantId, email: `other-admin-${f.token}@iso-it.invalid`, name: "Other", role: "SUPER_ADMIN", password: "x" } })
    extraUsers.push(other.id)
    const first = await statusAndBody(await adminReset(post({ userId: f.a.adminId }), ctx(f.a.tenantId)))
    expect(first.status).toBe(200)
    expect(m.mail.map((x) => x.to).sort()).toEqual([`admin-a-${f.token}@iso-it.invalid`, other.email].sort())
    expect((await adminReset(post({ userId: f.a.adminId }), ctx(f.a.tenantId))).status).toBe(429)

    // The other admin asked for a link themselves 5 minutes ago (30-minute link).
    const selfToken = `self-${f.token}`
    await db.user.update({ where: { id: other.id }, data: { resetToken: selfToken, resetTokenExp: new Date(Date.now() + 25 * 60_000) } })
    expect((await adminReset(post({ userId: other.id }), ctx(f.a.tenantId))).status).toBe(409)
    expect((await db.user.findUniqueOrThrow({ where: { id: other.id } })).resetToken).toBe(selfToken)
  })
})
