/**
 * Who may vouch for an address a signing code goes to, in both regimes, on real Postgres. No browser: the real code request, the real
 * confirmation routes and the real sync. A ZA client needs no approved application here: a document's code takes the same gate, and an
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
  sendEmail: vi.fn(async (..._args: unknown[]) => ({ ok: true, messageId: `provider-${Math.random()}`, provider: "SMTP", providerOutcome: "ACCEPTED", acceptedAt: new Date() })),
}))
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, { get(_t, key) { if (!holder.app) throw new Error("no client"); const v: unknown = Reflect.get(holder.app, key); return typeof v === "function" ? v.bind(holder.app) : v } })
  return { ...actual, prisma }
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
import { POST as borrowerConfirm } from "@/app/api/portal/contact-identity-confirmation/route"
import { PUT as borrowerProfile } from "@/app/api/portal/profile/route"
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
  const confirmAs = (clientId: string, userId: string, note = "Called the borrower back on the number on file.") => { asStaff(userId); return staffConfirm(json({ channel: "EMAIL", note }), on(clientId)) }

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
      expect((await confirmAs(clientId, stack.officer)).status).toBe(403)
      await expect(db().contactIdentity.updateMany({ where: { value: email }, data: { confirmedAt: new Date(), confirmedByUserId: stack.officer } })).rejects.toThrow(/ContactIdentity_confirmation/)
      expect((await confirmAs(clientId, stack.senior)).status).toBe(200)
      expect(await db().contactIdentity.findFirstOrThrow({ where: { value: email } })).toMatchObject({ confirmedByUserId: stack.senior })
      const audit = await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: clientId, action: "CONTACT_IDENTITY_CONFIRMED" } })
      expect(audit).toMatchObject({ userId: stack.senior })
      expect(audit.newValue).toMatchObject({ channel: "EMAIL", setByStaffUserId: stack.officer, confirmedBy: { type: "staff", id: stack.senior } })
      expect(await requestCode(clientId, email, "branch", stack.officer)).toMatchObject({ ok: true })
      expect((await confirmAs(clientId, stack.disburser)).status).toBe(409)
    })

    it("the confirmer does not witness: refused at the code and when it is spent", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("witness")
      const email = await staffChangesEmail(clientId, stack.officer)
      expect((await confirmAs(clientId, stack.senior)).status).toBe(200)
      expect(await requestCode(clientId, email, "branch", stack.senior)).toMatchObject({ ok: false, signingOtp: "identity_confirmed_by_witness" })
      const issued = await requestCode(clientId, email, "branch", stack.disburser)
      if (!issued.ok) throw new Error(issued.error)
      const spend = runWithTenant(stack.tenant, () => (holder.app as typeof import("@/lib/prisma").prisma).$transaction((tx) => consumeSigningOtp(tx, {
        tenantId: stack.tenant, clientId, purpose: "AGREEMENT", subjectId: `app-${clientId}`, documentSha256: "a".repeat(64), challengeId: issued.challenge.challengeId, method: "branch", now: new Date(), witnessUserId: stack.senior,
      })))
      await expect(spend).rejects.toThrow(SigningOtpRefusedError)
    })

    it("the borrower can confirm it in their own session, and their own change needs no one", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("own")
      const email = await staffChangesEmail(clientId, stack.officer)
      asClient(clientId)
      holder.session!.user.email = email
      expect((await borrowerConfirm(json({ channel: "EMAIL" }))).status).toBe(200)
      expect(await db().contactIdentity.findFirstOrThrow({ where: { value: email } })).toMatchObject({ confirmedByClientId: clientId, confirmedByUserId: null })
      expect(await requestCode(clientId, email, "portal")).toMatchObject({ ok: true })
      expect((await borrowerConfirm(json({ channel: "EMAIL" }))).status).toBe(409)

      const profile = await borrowerProfile(new Request("http://localhost/api/portal/profile", { method: "PUT", body: JSON.stringify({ whatsapp: jurisdiction === "LS" ? "+26658765432" : "0827654321" }), headers: { "content-type": "application/json" } }) as never)
      expect(profile.status, await profile.clone().text()).toBe(200)
      expect(await db().contactIdentity.findFirstOrThrow({ where: { tenantId: stack.tenant, channel: "WHATSAPP", contact: { clientId } } })).toMatchObject({ setByStaffUserId: null })
    })
  })
}

regime("LS")
regime("ZA")
