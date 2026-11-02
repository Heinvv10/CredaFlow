/**
 * Who may vouch for an address a signing code or a login recovery goes to, in both regimes, on real Postgres. No browser: the real code request, the real
 * confirmation and password routes and the real sync. A ZA client needs no approved application here: a document's code takes the same gate, and an
 * agreement's goes through requestSigningOtp, called directly so no NCA ceremony need be faked. The transport is a double: nothing leaves.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/contact/identity-confirmation.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({
  app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN",
  session: null as null | { user: Record<string, unknown> },
  /** Runs after the two-people check and before the claim: a write that lands between them. */
  afterCheck: null as null | (() => Promise<unknown>),
  sendEmail: vi.fn(async (..._args: unknown[]) => ({ ok: true, messageId: `provider-${Math.random()}`, provider: "SMTP", providerOutcome: "ACCEPTED", acceptedAt: new Date() })),
}))
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, { get(_t, key) { if (!holder.app) throw new Error("no client"); const v: unknown = Reflect.get(holder.app, key); return typeof v === "function" ? v.bind(holder.app) : v } })
  return { ...actual, prisma }
})
vi.mock("@/lib/security/account-control", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/security/account-control")>()
  return { ...actual, accountControlRefusal: async (...args: Parameters<typeof actual.accountControlRefusal>) => { const refusal = await actual.accountControlRefusal(...args); await holder.afterCheck?.(); return refusal } }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => holder.session) }))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: vi.fn(async () => ({ user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic", role: holder.role, tenantId: holder.tenantId, totpVerified: true } })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    ...(await importOriginal<typeof import("@/lib/tenant")>()),
    withTenantContext: (_req: unknown, handler: (tenant: object) => Promise<unknown>) => runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "IT", domain: null, status: "ACTIVE" })),
  }
})
vi.mock("@/lib/config/identity", async (importOriginal) => {
  const identity = { legalName: "Synthetic Lender", tradingName: "Synthetic Lender", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"], publicEmail: "hello@lender.example" }
  return { ...(await importOriginal<typeof import("@/lib/config/identity")>()), findLenderIdentity: async () => identity, getLenderIdentity: async () => identity }
})
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async () => ({ ok: true }) }))
vi.mock("@/lib/email/service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/email/service")>()), sendEmail: holder.sendEmail }))

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { provisionContactForClient } from "@/lib/contact/provision"
import { requestSigningOtp } from "@/lib/signing-otp/request"
import { consumeSigningOtp, SigningOtpRefusedError } from "@/lib/signing-otp/challenge"
import { runWithTenant } from "@/lib/tenant-scope"
import { PUT as putClient } from "@/app/api/clients/[id]/route"
import { POST as staffConfirm } from "@/app/api/clients/[id]/contact-identity-confirmation/route"
import { POST as forgotPassword } from "@/app/api/portal/forgot-password/route"
import { PUT as borrowerProfile } from "@/app/api/portal/profile/route"
import { POST as registerPortal } from "@/app/api/portal/register/route"
import { POST as resetPassword } from "@/app/api/portal/reset-password/route"
import { createRlsRole, seedBorrower, seedStack, stackOf, type Stack, type StackJurisdiction } from "@/lib/non-nca-documents/ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip

function regime(jurisdiction: StackJurisdiction) {
  const t = randomUUID().replaceAll("-", "").slice(0, 10)
  const stack: Stack = stackOf(jurisdiction, t)
  const role = `cf_idconf_${jurisdiction.toLowerCase()}_${t}`
  let fresh: ThrowawayDb
  let app: ReturnType<typeof createAppPrismaClient> | undefined
  const db = () => fresh.db
  const json = (body: unknown, method = "POST") => new NextRequest("http://localhost/x", { method, body: JSON.stringify(body), headers: { "content-type": "application/json" } })
  const on = (id: string) => ({ params: Promise.resolve({ id }) })
  const asStaff = (userId: string) => { holder.userId = userId; holder.role = "LOAN_ADMIN"; holder.session = { user: { id: userId, role: "LOAN_ADMIN", email: `${userId}@test.invalid`, tenantId: stack.tenant } } }
  const asClient = (clientId: string) => { holder.session = { user: { id: clientId, role: "CLIENT", email: `${clientId}@test.invalid`, tenantId: stack.tenant } } }

  async function borrower(name: string) {
    const id = `${name}-${t}`
    await seedBorrower(db(), stack, id)
    const clientId = `${id}-client`
    await db().$transaction(async (tx) => {
      const c = await tx.client.findUniqueOrThrow({ where: { id: clientId } })
      await provisionContactForClient(tx as never, { tenantId: stack.tenant, clientId, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, whatsapp: c.whatsapp, source: "MANUAL" })
    })
    return clientId
  }
  async function staffChangesEmail(clientId: string, officer: string) {
    const before = await db().client.findUniqueOrThrow({ where: { id: clientId } })
    const email = `typed-${randomUUID().slice(0, 8)}@test.invalid`
    asStaff(officer)
    const res = await putClient(json({ email, expectedUpdatedAt: before.updatedAt.toISOString() }, "PUT"), on(clientId))
    expect(res.status, await res.clone().text()).toBe(200)
    return email
  }
  /** The code request both regimes make: the real service, for an agreement. */
  const requestCode = (clientId: string, email: string, method: "portal" | "branch", userId?: string) => runWithTenant(stack.tenant, () => requestSigningOtp({
    subject: { tenantId: stack.tenant, clientId, purpose: "AGREEMENT", subjectId: `app-${clientId}`, documentSha256: "a".repeat(64), recipient: { firstName: "Synthetic", lastName: "Borrower", email, whatsapp: null } },
    channel: "EMAIL", method, ip: null, actor: { userId, email: "x@test.invalid" },
  }))
  const identityOf = (email: string) => db().contactIdentity.findFirstOrThrow({ where: { tenantId: stack.tenant, channel: "EMAIL", value: email } })
  const confirmAs = async (clientId: string, email: string, userId: string, note = "Called the borrower back on the number on file.") => {
    const identity = await identityOf(email)
    asStaff(userId)
    return staffConfirm(json({ identityId: identity.id, note }), on(clientId))
  }

  suite(`who vouches for a signing address (${jurisdiction}, real Postgres)`, () => {
    beforeAll(async () => {
      fresh = await createThrowawayDb(jurisdiction === "LS" ? { instance: { jurisdiction: "LS", currency: "LSL" } } : {})
      holder.tenantId = stack.tenant
      await seedStack(db(), stack, { code: "IDC" })
      await db().emailConfig.create({ data: { tenantId: stack.tenant, fromName: "Lender", fromAddress: "hello@lender.example" } })
      vi.stubEnv("TENANT_RLS", "on")
      vi.stubEnv("AUTH_SECRET", "synthetic-auth-secret-for-this-suite")
      vi.stubEnv("UNSUB_TOKEN_SECRET", "synthetic-unsub-secret-for-this-suite")
      vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000")
      app = createAppPrismaClient(await createRlsRole(db(), fresh.url, role))
      holder.app = app
      resetActiveJurisdiction()
      resetEnsuredJurisdiction()
      await ensureActiveJurisdiction(app as never)
    }, 300_000)

    afterAll(async () => {
      vi.unstubAllEnvs()
      holder.app = null
      await app?.$disconnect()
      await fresh?.db.$executeRawUnsafe(`DROP OWNED BY ${role}`).catch(() => undefined)
      await fresh?.drop()
      const admin = new PrismaClient()
      await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined)
      await admin.$disconnect()
      resetActiveJurisdiction()
      resetEnsuredJurisdiction()
    }, 60_000)

    it("an existing address is verified: no backfill, the code goes", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("old")
      const email = (await db().client.findUniqueOrThrow({ where: { id: clientId } })).email!
      expect(await requestCode(clientId, email, "branch", stack.officer)).toMatchObject({ ok: true })
    })

    it("an address staff typed takes ordinary mail but no signing code, in the portal or at the branch", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("typed")
      const email = await staffChangesEmail(clientId, stack.officer)
      expect(await db().contactIdentity.findFirstOrThrow({ where: { value: email } })).toMatchObject({ setByStaffUserId: stack.officer, confirmedAt: null })
      expect(await db().contact.findFirstOrThrow({ where: { clientId } })).toMatchObject({ primaryEmail: email })
      holder.sendEmail.mockClear()
      for (const [method, user] of [["branch", stack.officer], ["branch", stack.disburser], ["portal", undefined]] as const) {
        expect(await requestCode(clientId, email, method, user)).toMatchObject({ ok: false, status: 409, signingOtp: "identity_unconfirmed" })
      }
      expect(holder.sendEmail).not.toHaveBeenCalled()
    })

    it("the setter cannot confirm it, by the route or a raw write; a different staff member can, audited", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("second")
      const email = await staffChangesEmail(clientId, stack.officer)
      expect((await confirmAs(clientId, email, stack.officer)).status).toBe(403)
      await expect(db().contactIdentity.updateMany({ where: { value: email }, data: { confirmedAt: new Date(), confirmedByUserId: stack.officer } })).rejects.toThrow(/ContactIdentity_confirmation/)
      expect((await confirmAs(clientId, email, stack.senior)).status).toBe(200)
      expect(await db().contactIdentity.findFirstOrThrow({ where: { value: email } })).toMatchObject({ confirmedByUserId: stack.senior })
      const audit = await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: clientId, action: "CONTACT_IDENTITY_CONFIRMED" } })
      expect(audit).toMatchObject({ userId: stack.senior })
      expect(audit.newValue).toMatchObject({ identityId: (await identityOf(email)).id, channel: "EMAIL", maskedValue: expect.stringContaining("***"), setByStaffUserId: stack.officer })
      expect(JSON.stringify(audit.newValue)).not.toContain(email)
      expect(await requestCode(clientId, email, "branch", stack.officer)).toMatchObject({ ok: true })
      expect((await confirmAs(clientId, email, stack.disburser)).status).toBe(409)
    })

    it("a confirmation names the row reviewed: a value changed under the reviewer, or another borrower's, is refused", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("bound")
      const reviewed = await staffChangesEmail(clientId, stack.officer)
      const stale = await identityOf(reviewed)
      const replaced = await staffChangesEmail(clientId, stack.officer)
      asStaff(stack.senior)
      expect((await staffConfirm(json({ identityId: stale.id, note: "Reviewed the earlier address." }), on(clientId))).status).toBe(409)
      expect(await identityOf(replaced)).toMatchObject({ confirmedAt: null })
      const other = await borrower("other")
      expect((await staffConfirm(json({ identityId: (await identityOf(replaced)).id, note: "Sent it to the wrong client." }), on(other))).status).toBe(409)
      expect(await identityOf(replaced)).toMatchObject({ confirmedAt: null })
    })

    it("the confirmer does not witness: refused at the code and when it is spent", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("witness")
      const email = await staffChangesEmail(clientId, stack.officer)
      expect((await confirmAs(clientId, email, stack.senior)).status).toBe(200)
      expect(await requestCode(clientId, email, "branch", stack.senior)).toMatchObject({ ok: false, signingOtp: "identity_confirmed_by_witness" })
      const issued = await requestCode(clientId, email, "branch", stack.disburser)
      if (!issued.ok) throw new Error(issued.error)
      const spend = runWithTenant(stack.tenant, () => (holder.app as typeof import("@/lib/prisma").prisma).$transaction((tx) => consumeSigningOtp(tx, {
        tenantId: stack.tenant, clientId, purpose: "AGREEMENT", subjectId: `app-${clientId}`, documentSha256: "a".repeat(64), challengeId: issued.challenge.challengeId, method: "branch", now: new Date(), witnessUserId: stack.senior,
      })))
      await expect(spend).rejects.toBeInstanceOf(SigningOtpRefusedError)
      await expect(spend).rejects.toMatchObject({ reason: "identity_confirmed_by_witness" })
    })

    it("a second account of the confirmer does not witness either: refused at the code and when it is spent", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("witness-puppet")
      const email = await staffChangesEmail(clientId, stack.officer)
      expect((await confirmAs(clientId, email, stack.senior)).status).toBe(200)
      const puppet = `witness-puppet-${t}`
      await db().user.create({ data: { id: puppet, tenantId: stack.tenant, email: `${puppet}@test.invalid`, password: "not-a-real-login", name: "Witness puppet", role: "LOAN_ADMIN" } })
      await db().auditLog.create({ data: { tenantId: stack.tenant, userId: stack.senior, userEmail: `${stack.senior}@test.invalid`, action: "USER_CREATED", entity: "User", entityId: puppet } })
      expect(await requestCode(clientId, email, "branch", puppet)).toMatchObject({ ok: false, signingOtp: "identity_confirmed_by_witness" })
      const issued = await requestCode(clientId, email, "branch", stack.disburser)
      if (!issued.ok) throw new Error(issued.error)
      const spend = runWithTenant(stack.tenant, () => (holder.app as typeof import("@/lib/prisma").prisma).$transaction((tx) => consumeSigningOtp(tx, {
        tenantId: stack.tenant, clientId, purpose: "AGREEMENT", subjectId: `app-${clientId}`, documentSha256: "a".repeat(64), challengeId: issued.challenge.challengeId, method: "branch", now: new Date(), witnessUserId: puppet,
      })))
      await expect(spend).rejects.toMatchObject({ reason: "identity_confirmed_by_witness" })
    })

    it("a staff-set address cannot recover the portal login: no code is sent, a code is not accepted, and activation is refused", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("recover")
      await db().client.update({ where: { id: clientId }, data: { portalPassword: "unchanged-hash" } })
      const email = await staffChangesEmail(clientId, stack.officer)
      holder.session = null
      holder.sendEmail.mockClear()
      const forgot = await forgotPassword(json({ email, turnstileToken: "x" }))
      expect(forgot.status, "the same answer as for no account").toBe(200)
      expect(await forgot.json()).toEqual({ success: true })
      expect(holder.sendEmail).not.toHaveBeenCalled()
      expect(await db().clientOtp.count({ where: { email } })).toBe(0)

      await db().clientOtp.create({ data: { email, otp: "123456", expiresAt: new Date(Date.now() + 600_000) } })
      const password = "Synthetic-Passw0rd!-long"
      const reset = await resetPassword(json({ email, otp: "123456", password, confirmPassword: password, turnstileToken: "x" }))
      expect(reset.status).toBe(404)
      expect((await db().client.findUniqueOrThrow({ where: { id: clientId } })).portalPassword).toBe("unchanged-hash")

      const unactivated = await borrower("activate")
      const staffTyped = await staffChangesEmail(unactivated, stack.officer)
      const idNumber = (await db().client.findUniqueOrThrow({ where: { id: unactivated } })).idNumber
      holder.sendEmail.mockClear()
      expect((await registerPortal(json({ email: staffTyped, idNumber, turnstileToken: "x" }))).status).toBe(200)
      expect(await db().clientOtp.count({ where: { email: staffTyped } })).toBe(0)

      await db().clientOtp.create({ data: { email: staffTyped, otp: "654321", expiresAt: new Date(Date.now() + 600_000) } })
      const activate = await registerPortal(json({ email: staffTyped, idNumber, otp: "654321", password, confirmPassword: password, turnstileToken: "x" }))
      expect(activate.status, await activate.clone().text()).toBe(400)
      expect((await db().client.findUniqueOrThrow({ where: { id: unactivated } })).portalPassword).toBeNull()

      // A second person's word opens it again.
      expect((await confirmAs(clientId, email, stack.senior)).status).toBe(200)
      holder.session = null
      expect((await forgotPassword(json({ email, turnstileToken: "x" }))).status).toBe(200)
      expect(await db().clientOtp.count({ where: { email, used: false } })).toBe(2)
    })

    it("a second account of whoever set the address is not a second person", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("puppet")
      const email = await staffChangesEmail(clientId, stack.officer)
      await db().user.create({ data: { id: `puppet-${t}`, tenantId: stack.tenant, email: `puppet-${t}@test.invalid`, password: "not-a-real-login", name: "Puppet", role: "LOAN_ADMIN" } })
      await db().auditLog.create({ data: { tenantId: stack.tenant, userId: stack.officer, userEmail: `${stack.officer}@test.invalid`, action: "USER_CREATED", entity: "User", entityId: `puppet-${t}` } })
      const res = await confirmAs(clientId, email, `puppet-${t}`)
      expect(res.status).toBe(403)
      expect((await res.json()).error).toContain("Two people")
      expect((await identityOf(email)).confirmedAt).toBeNull()
      expect((await confirmAs(clientId, email, stack.confirmer)).status).toBe(200)
    })

    it.each([
      ["another setter", { setByStaffUserId: "other" }], ["another value", { value: "moved@test.invalid" }],
    ])("a row changed to %s between the check and the claim is not confirmed", async (name, change) => {
      holder.tenantId = stack.tenant
      const clientId = await borrower(`race-${name.split(" ")[1]}`)
      const email = await staffChangesEmail(clientId, stack.officer)
      const { id } = await identityOf(email)
      const data = "setByStaffUserId" in change ? { setByStaffUserId: stack.disburser } : { value: `moved-${t}@test.invalid` }
      holder.afterCheck = () => { holder.afterCheck = null; return db().contactIdentity.update({ where: { id }, data }) }
      expect((await confirmAs(clientId, email, stack.confirmer)).status).toBe(409)
      expect(await db().contactIdentity.findUniqueOrThrow({ where: { id } })).toMatchObject({ ...data, confirmedAt: null, confirmedByUserId: null })
    })

    it("the borrower's own change needs no one", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("own")
      asClient(clientId)
      holder.session!.user.email = (await db().client.findUniqueOrThrow({ where: { id: clientId } })).email
      const profile = await borrowerProfile(new Request("http://localhost/api/portal/profile", { method: "PUT", body: JSON.stringify({ whatsapp: jurisdiction === "LS" ? "+26658765432" : "0827654321" }), headers: { "content-type": "application/json" } }) as never)
      expect(profile.status, await profile.clone().text()).toBe(200)
      expect(await db().contactIdentity.findFirstOrThrow({ where: { tenantId: stack.tenant, channel: "WHATSAPP", contact: { clientId } } })).toMatchObject({ setByStaffUserId: null })
    })

    it("first capture: a key-facts lender's needs the second person, a South African one's is as it was", async () => {
      holder.tenantId = stack.tenant
      const id = `capture-${t}`
      await seedBorrower(db(), stack, id)
      const c = await db().client.findUniqueOrThrow({ where: { id: `${id}-client` } })
      await db().$transaction((tx) => provisionContactForClient(tx as never, {
        tenantId: stack.tenant, clientId: c.id, email: c.email, phone: c.phone, whatsapp: "+26658112233", setByStaffUserId: jurisdiction === "LS" ? stack.officer : null,
      }))
      const rows = await db().contactIdentity.findMany({ where: { tenantId: stack.tenant, contact: { clientId: c.id } } })
      const setter = jurisdiction === "LS" ? stack.officer : null
      expect(rows.find((r) => r.channel === "EMAIL")).toMatchObject({ setByStaffUserId: setter })
      expect(rows.find((r) => r.channel === "WHATSAPP")).toMatchObject({ setByStaffUserId: setter })
      expect(rows.find((r) => r.channel === "SMS")).toMatchObject({ setByStaffUserId: null })
    })
  })
}

regime("LS")
regime("ZA")
