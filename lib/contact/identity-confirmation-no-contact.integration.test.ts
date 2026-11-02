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
import { provisionContactForClient, provisionContactForLead } from "@/lib/contact/provision"
import { requestSigningOtp } from "@/lib/signing-otp/request"
import { runWithTenant } from "@/lib/tenant-scope"
import { PUT as putClient } from "@/app/api/clients/[id]/route"
import { POST as forgotPassword } from "@/app/api/portal/forgot-password/route"
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

  /** A Contact of its own, as the client-create route writes. */
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
  /**
 * A client with no Contact (legacy, or captured by a dealer) under the staff-set address rule, in both regimes, on real Postgres: the real client edit, the
 * real password routes and the real sync. The transport is a double: nothing leaves.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/contact/identity-confirmation-no-contact.integration.test.ts
 */
  const requestCode = (clientId: string, email: string, method: "portal" | "branch", userId?: string) => runWithTenant(stack.tenant, () => requestSigningOtp({
    subject: { tenantId: stack.tenant, clientId, purpose: "AGREEMENT", subjectId: `app-${clientId}`, documentSha256: "a".repeat(64), recipient: { firstName: "Synthetic", lastName: "Borrower", email, whatsapp: null } },
    channel: "EMAIL", method, ip: null, actor: { userId, email: "x@test.invalid" },
  }))
  const identityOf = (email: string) => db().contactIdentity.findFirstOrThrow({ where: { tenantId: stack.tenant, channel: "EMAIL", value: email } })
  const noRecovery = async (clientId: string, email: string) => {
    holder.session = null
    await forgotPassword(json({ email, turnstileToken: "x" }))
    expect(await db().clientOtp.count({ where: { email } }), "forgot-password issued a code").toBe(0)
    await db().clientOtp.create({ data: { email, otp: "111222", expiresAt: new Date(Date.now() + 600_000) } })
    const password = "Synthetic-Passw0rd!-long"
    expect((await resetPassword(json({ email, otp: "111222", password, confirmPassword: password, turnstileToken: "x" }))).status).toBe(404)
    expect((await db().client.findUniqueOrThrow({ where: { id: clientId } })).portalPassword).toBe("unchanged-hash")
  }
  /** An address another Contact already holds. */
  async function heldElsewhere(name: string) {
    const email = `lead-${name}-${t}@test.invalid`
    const lead = await db().lead.create({ data: { tenantId: stack.tenant, firstName: "Synthetic", lastName: "Lead", phone: `+26658${String(Date.now()).slice(-6)}`, email, source: "WEBSITE" } })
    await db().$transaction((tx) => provisionContactForLead(tx as never, { tenantId: stack.tenant, leadId: lead.id, email }))
    return email
  }
  const putEmail = async (clientId: string, email: string, officer: string) => {
    const before = await db().client.findUniqueOrThrow({ where: { id: clientId } })
    asStaff(officer)
    const res = await putClient(json({ email, expectedUpdatedAt: before.updatedAt.toISOString() }, "PUT"), on(clientId))
    expect(res.status, await res.clone().text()).toBe(200)
  }

  suite(`a client with no Contact (${jurisdiction}, real Postgres)`, () => {
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

    it("keeps their own recovery; a staff edit creates the Contact and the rule holds", async () => {
      holder.tenantId = stack.tenant
      const id = `bare-${t}`
      await seedBorrower(db(), stack, id)
      const clientId = `${id}-client`
      await db().client.update({ where: { id: clientId }, data: { portalPassword: "unchanged-hash" } })
      const own = `${id}@test.invalid`
      holder.session = null
      await forgotPassword(json({ email: own, turnstileToken: "x" }))
      expect(await db().clientOtp.count({ where: { email: own } }), "a legacy client keeps their recovery").toBe(1)
      const email = await staffChangesEmail(clientId, stack.officer)
      expect(await identityOf(email)).toMatchObject({ setByStaffUserId: stack.officer, confirmedAt: null })
      expect(await db().contact.findFirstOrThrow({ where: { clientId } })).toMatchObject({ status: "CLIENT", primaryEmail: email })
      await noRecovery(clientId, email)
    })

    it("a staff WhatsApp edit leaves the email as it stood, with no setter", async () => {
      holder.tenantId = stack.tenant
      const id = `bare2-${t}`
      await seedBorrower(db(), stack, id)
      const clientId = `${id}-client`
      const before = await db().client.findUniqueOrThrow({ where: { id: clientId } })
      asStaff(stack.officer)
      const whatsapp = jurisdiction === "LS" ? `+26662${String(Date.now()).slice(-6)}` : `082${String(Date.now()).slice(-7)}`
      const res = await putClient(json({ whatsapp, expectedUpdatedAt: before.updatedAt.toISOString() }, "PUT"), on(clientId))
      expect(res.status, await res.clone().text()).toBe(200)
      const rows = await db().contactIdentity.findMany({ where: { tenantId: stack.tenant, contact: { clientId } } })
      expect(rows.find((r) => r.channel === "EMAIL")).toMatchObject({ value: before.email, setByStaffUserId: null })
      expect(rows.find((r) => r.channel === "WHATSAPP")).toMatchObject({ setByStaffUserId: stack.officer })
    })

    it("an address another Contact holds is not refused, and cannot recover the login or take a signing code", async () => {
      holder.tenantId = stack.tenant
      const id = `bare3-${t}`
      await seedBorrower(db(), stack, id)
      const clientId = `${id}-client`
      await db().client.update({ where: { id: clientId }, data: { portalPassword: "unchanged-hash" } })
      const taken = await heldElsewhere("bare")
      await putEmail(clientId, taken, stack.officer)
      expect((await db().contact.findFirstOrThrow({ where: { clientId } })).staffAddressUnresolvedAt).not.toBeNull()
      await noRecovery(clientId, taken)
      holder.sendEmail.mockClear()
      await requestCode(clientId, taken, "portal").catch(() => undefined)
      expect(holder.sendEmail).not.toHaveBeenCalled()
    })

    it("a client with a Contact: a held address, then a change that leaves it held, stays shut until a free address replaces it", async () => {
      holder.tenantId = stack.tenant
      const clientId = await borrower("held")
      await db().client.update({ where: { id: clientId }, data: { portalPassword: "unchanged-hash" } })
      const taken = await heldElsewhere("held")
      await putEmail(clientId, taken, stack.officer)
      const client = await db().client.findUniqueOrThrow({ where: { id: clientId } })
      asStaff(stack.officer)
      const whatsapp = jurisdiction === "LS" ? `+26663${String(Date.now()).slice(-6)}` : `083${String(Date.now()).slice(-7)}`
      expect((await putClient(json({ whatsapp, expectedUpdatedAt: client.updatedAt.toISOString() }, "PUT"), on(clientId))).status).toBe(200)
      expect((await db().contact.findFirstOrThrow({ where: { clientId } })).staffAddressUnresolvedAt, "a change to another channel leaves it").not.toBeNull()
      await noRecovery(clientId, taken)
      const free = await staffChangesEmail(clientId, stack.officer)
      expect((await db().contact.findFirstOrThrow({ where: { clientId } })).staffAddressUnresolvedAt).toBeNull()
      await noRecovery(clientId, free)
    })

    it("dealer-captured: unverified stays shut on its gate; once verified, a staff-edited address still needs a confirmer", async () => {
      holder.tenantId = stack.tenant
      const dealer = await db().dealer.create({ data: { tenantId: stack.tenant, name: `Synthetic Dealer ${t}`, kind: "DEALER", contactEmail: "dealer@test.invalid", createdById: stack.officer } })
      const id = `dealer-${t}`
      await seedBorrower(db(), stack, id, { dealerId: dealer.id })
      const clientId = `${id}-client`
      expect(await db().contact.count({ where: { clientId } }), "capture writes no Contact").toBe(0)
      holder.session = null
      await forgotPassword(json({ email: `${id}@test.invalid`, turnstileToken: "x" }))
      expect(await db().clientOtp.count({ where: { email: `${id}@test.invalid` } })).toBe(0)
      const email = await staffChangesEmail(clientId, stack.officer)
      await db().client.update({ where: { id: clientId }, data: { dealerContactVerifiedAt: new Date(), dealerContactVerifiedById: stack.officer, portalPassword: "unchanged-hash" } })
      expect(await identityOf(email)).toMatchObject({ setByStaffUserId: stack.officer, confirmedAt: null })
      await noRecovery(clientId, email)
    })
  })
}

regime("LS")
regime("ZA")
