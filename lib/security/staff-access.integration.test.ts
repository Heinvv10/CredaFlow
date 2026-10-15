/**
 * Real-Postgres proof of the staff access policy plumbing: the audited write
 * path, the policy riding on revalidatePrincipal's one query (the relation
 * select a mocked Prisma cannot check), the sign-in refusal records, and the
 * portal switches' write path.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/security/staff-access.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { PrismaClient } from "@prisma/client"

vi.stubEnv("AUTH_SECRET", "integration-test-secret")
// next-auth cannot load outside Next; revalidatePrincipal is a plain function
// over the real Prisma client, so only the NextAuth() factory is stubbed.
vi.mock("next-auth", () => ({
  default: () => ({ handlers: {}, auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }),
  CredentialsSignin: class {},
}))
vi.mock("next-auth/providers/credentials", () => ({ default: (config: unknown) => config }))

import { prisma } from "@/lib/prisma"
import { revalidatePrincipal } from "@/lib/auth"
import { applyStaffAccessPolicy } from "./staff-access-write"
import { checkStaffSignIn } from "./staff-access-enforcement"
import { applyPortalPolicy, getPortalPolicy } from "@/lib/portal/portal-policy"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_access_${t}`
const userId = `u_access_${t}`
const email = `${userId}@test.invalid`
const actor = { id: userId, email }
const HOURS = {
  mon: { start: "08:00", end: "17:00" }, tue: null, wed: null, thu: null, fri: null, sat: null, sun: null,
}

suite("staff access policy (real database)", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: `access-${t}`, name: "Staff Access IT", domain: `access-${t}.staff-access-it.test` } })
    await db.user.create({
      data: { id: userId, tenantId, email, name: "Synthetic Staff", password: "not-a-login-credential", role: "CREDIT_OFFICER" },
    })
  })
  afterAll(async () => {
    await db.auditLog.deleteMany({ where: { tenantId } })
    await db.loginLog.deleteMany({ where: { tenantId } })
    await db.failedLoginAttempt.deleteMany({ where: { email } })
    await db.user.deleteMany({ where: { id: userId } })
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.tenant.deleteMany({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("an unconfigured tenant gives the session gate nothing to enforce", async () => {
    // W1's shared revalidation (lib/auth-principal.ts) also returns the
    // operator binding (none) and the enrolment hold (unenrolled user, no
    // TenantConfig row: the 2FA policy defaults on).
    expect(await revalidatePrincipal(userId, 0)).toEqual({
      role: "CREDIT_OFFICER", tenantId, accessPolicy: null, operatorId: null, totpEnrolmentRequired: true,
    })
  })

  it("writes the policy with its audit row, and the session read returns it in the same query", async () => {
    const result = await prisma.$transaction((tx) => applyStaffAccessPolicy(tx, {
      tenantId, actor, next: { hours: HOURS, ipAllowlist: ["192.0.2.0/24"] }, ipAddress: "192.0.2.1",
    }))
    expect(result).toEqual({ changed: true })
    const audit = await db.auditLog.findFirstOrThrow({ where: { tenantId, action: "STAFF_ACCESS_POLICY_UPDATED" } })
    expect(audit).toMatchObject({ userId, oldValue: { hours: null, ipAllowlist: [] } })

    const principal = await revalidatePrincipal(userId, 0)
    expect(principal).toMatchObject({ accessPolicy: { staffAccessHours: HOURS, staffIpAllowlist: ["192.0.2.0/24"] } })

    // Writing the same policy again changes and audits nothing, even though
    // JSONB hands the hours back with its own key order.
    expect(await prisma.$transaction((tx) => applyStaffAccessPolicy(tx, {
      tenantId, actor, next: { hours: HOURS, ipAllowlist: ["192.0.2.0/24"] },
    }))).toEqual({ changed: false })
    expect(await db.auditLog.count({ where: { tenantId, action: "STAFF_ACCESS_POLICY_UPDATED" } })).toBe(1)
  })

  it("records a refused sign-in in FailedLoginAttempt, LoginLog and the audit log", async () => {
    const decision = await checkStaffSignIn(
      { tenantId, userId, email, role: "CREDIT_OFFICER", ip: "198.51.100.4", userAgent: "vitest" },
      new Date("2026-10-12T08:00:00.000Z"), // Monday 10:00 SAST: in hours, wrong network
    )
    expect(decision).toEqual({ allowed: false, reason: "ip_not_allowed" })
    expect(await db.failedLoginAttempt.findFirst({ where: { email, reason: "access_ip_not_allowed" } })).not.toBeNull()
    expect(await db.loginLog.findFirst({ where: { tenantId, userId, success: false } })).not.toBeNull()
    expect(await db.auditLog.findFirst({ where: { tenantId, action: "STAFF_ACCESS_REFUSED", entityId: userId } }))
      .toMatchObject({ newValue: expect.objectContaining({ reason: "ip_not_allowed", stage: "sign_in" }) })
  })

  it("writes the portal switches with an audit row and reads them back", async () => {
    const next = { requireSigningOtp: false, signingOtpBranchExempt: true, allowNewRegistrations: false }
    await prisma.$transaction((tx) => applyPortalPolicy(tx, { tenantId, actor, next }))
    expect(await getPortalPolicy(tenantId)).toEqual({ portalEnabled: true, ...next })
    expect(await db.auditLog.findFirst({ where: { tenantId, action: "PORTAL_POLICY_UPDATED" } }))
      .toMatchObject({ newValue: next, oldValue: { requireSigningOtp: true, signingOtpBranchExempt: true, allowNewRegistrations: true } })
  })
})
