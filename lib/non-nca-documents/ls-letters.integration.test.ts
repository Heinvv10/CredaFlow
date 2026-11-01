/**
 * The edges of PR C on real Postgres through the real routes, around ls-walk.integration.test.ts's happy path: what the database and
 * the routes refuse for the offer letter and a signature at a branch.
 * Nothing leaves: the email transport is a double. Mocks as in ls-walk.integration.test.ts.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/non-nca-documents/ls-letters.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({
  app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN", files: new Map<string, Buffer>(),
  session: null as null | { user: Record<string, unknown> }, otpRequired: false,
  sendEmail: vi.fn(async (..._args: unknown[]) => ({ ok: true, messageId: `provider-${Math.random()}`, provider: "SMTP", providerOutcome: "ACCEPTED", acceptedAt: new Date() })),
}))
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, {
    get(_t, key) {
      if (!holder.app) throw new Error("the RLS-bound app client is created in beforeAll")
      const value: unknown = Reflect.get(holder.app, key)
      return typeof value === "function" ? value.bind(holder.app) : value
    },
  })
  return { ...actual, prisma }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => holder.session) }))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: vi.fn(async () => ({
    user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: holder.role, tenantId: holder.tenantId, totpVerified: true },
  })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return {
    ...(await importOriginal<typeof import("@/lib/tenant")>()),
    withTenantContext: (_req: unknown, handler: (tenant: object) => Promise<unknown>) =>
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Lesotho letters IT", domain: null, status: "ACTIVE" })),
  }
})
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => ({ failedLegs: [] })) }))
vi.mock("@/lib/email/service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/email/service")>()), sendEmail: holder.sendEmail }))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  saveFile: async (buffer: Buffer) => { const path = `/mem/${holder.files.size}.pdf`; holder.files.set(path, buffer); return { storagePath: path, fileSize: buffer.length } },
  readFile: async (path: string) => { const b = holder.files.get(path); if (!b) throw new Error("missing"); return b },
  deleteFile: async (path: string) => { holder.files.delete(path) },
}))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (html: string) => Buffer.from(`%PDF-synthetic ${html} ${randomUUID()}`) }))
vi.mock("@/lib/signing-otp/policy", async (original) => ({ ...(await original<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => holder.otpRequired }))
vi.mock("@/lib/config/identity", async (importOriginal) => {
  const identity = { legalName: "Demo Basotho Lending (Pty) Ltd", tradingName: "Demo Basotho Lending", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }
  return { ...(await importOriginal<typeof import("@/lib/config/identity")>()), findLenderIdentity: async () => identity, getLenderIdentity: async () => identity }
})

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { hashSigningOtp } from "@/lib/signing-otp/code"
import { PUT as putClient } from "@/app/api/clients/[id]/route"
import { POST as requestCode } from "@/app/api/signing-otp/route"
import { provisionContactForClient } from "@/lib/contact/provision"
import { POST as accept } from "@/app/api/applications/[id]/loan-documents/accept/route"
import { POST as branchSign } from "@/app/api/applications/[id]/loan-documents/branch-sign/route"
import { POST as acknowledge } from "@/app/api/applications/[id]/loan-documents/acknowledge/route"
import { POST as sign } from "@/app/api/applications/[id]/loan-documents/sign/route"
import { AGREEMENT_KEY, KFS_KEY, OFFER_KEY, createTemplate } from "./gate.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"
import { confirmContactIdentity } from "@/lib/contact/identity-confirmation"
import { deliverToBorrower, operationIdFor } from "./deliver"
import { lsFlow } from "./ls-flow.integration-fixture"
import { signKeyFactsAgreement } from "./sign"
import { clearOpenFlags, createRlsRole, seedBorrower, seedStack, stackOf } from "./ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_lsletters_${t}`
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}}</p>`

let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const flow = lsFlow(db, stack, holder)
const post = (body?: unknown) => new NextRequest("http://localhost/x", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) })
const on = (id: string) => ({ params: Promise.resolve({ id }) })
const asClient = (id: string) => { holder.session = { user: { id: `${id}-client`, role: "CLIENT", email: `${id}@test.invalid`, tenantId: stack.tenant } } }
const asStaff = (userId = stack.officer, staffRole = "LOAN_ADMIN") => { holder.userId = userId; holder.role = staffRole; holder.session = { user: { id: userId, role: staffRole, email: `${userId}@test.invalid`, tenantId: stack.tenant } } }
const provisionContact = (id: string) => db().$transaction(async (tx) => {
  const c = await tx.client.findUniqueOrThrow({ where: { id: `${id}-client` } })
  await provisionContactForClient(tx as never, { tenantId: stack.tenant, clientId: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, whatsapp: c.whatsapp, source: "MANUAL" })
})
const clearOpenFlagsAgain = (id: string) => clearOpenFlags(db(), stack, id)
const digests = async (id: string) => {
  const rows = await db().loanDocumentIssuance.findMany({ where: { applicationId: id, supersededAt: null } })
  const of = (kind: string) => rows.find((r) => r.kind === kind)!.pdfSha256
  return { offer: of("OFFER_LETTER"), kfs: of("KEY_FACTS_STATEMENT"), agreement: of("LOAN_AGREEMENT") }
}
/** A code that reached the borrower and that they read back: what /api/signing-otp and its verify step leave behind. */
async function verifiedCode(id: string, documentSha256: string, over: { clientId?: string; subjectId?: string; verified?: boolean; requestedByUserId?: string | null } = {}) {
  const challengeId = randomUUID()
  await db().signingOtpChallenge.create({
    data: {
      id: challengeId, tenantId: stack.tenant, clientId: over.clientId ?? `${id}-client`, purpose: "AGREEMENT", subjectId: over.subjectId ?? id, documentSha256,
      codeHash: hashSigningOtp(challengeId, "123456"), channel: "EMAIL", maskedDestination: "s***@test.invalid", expiresAt: new Date(Date.now() + 600_000),
      deliveryStatus: "ACCEPTED", sentAt: new Date(), verifiedAt: over.verified === false ? null : new Date(), requestedByUserId: over.requestedByUserId === undefined ? stack.officer : over.requestedByUserId, attempts: 1, maxAttempts: 5,
    },
  })
  return challengeId
}

suite("the letters and the branch (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "LTR", isDemoLender: true })
    for (const [key, title] of [[OFFER_KEY, "Offer letter"], [KFS_KEY, "Key facts statement"], [AGREEMENT_KEY, "Loan agreement"]] as const) await createTemplate(db(), stack.tenant, key, BODY(title))
    await db().emailConfig.create({ data: { tenantId: stack.tenant, fromName: "Demo Basotho Lending", fromAddress: "hello@basotho-lending.example" } })
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

  describe("the offer letter", () => {
    it("is accepted once, by the borrower, on the bytes they were shown", async () => {
      const id = `offer-${t}`
      await flow.approvedApplication(id)
      const { offer } = await digests(id)
      asClient(id)
      expect((await accept(post({ documentSha256: "0".repeat(64) }), on(id))).status).toBe(409)
      expect((await accept(post({ documentSha256: offer }), on(id))).status).toBe(200)
      expect((await accept(post({ documentSha256: offer }), on(id))).status).toBe(200)
      expect(await db().auditLog.count({ where: { tenantId: stack.tenant, entityId: id, action: "LOAN_OFFER_ACCEPTED" } })).toBe(1)
      const row = await db().loanDocumentIssuance.findFirstOrThrow({ where: { applicationId: id, kind: "OFFER_LETTER" } })
      expect(row).toMatchObject({ acknowledgedById: `${id}-client`, acknowledgedSha256: offer })
    })

    it("row-level security: another tenant's session sees no issued document", async () => {
      const id = `rls-${t}`
      await flow.approvedApplication(id)
      const count = (tenantId: string) => runWithTenant(tenantId, () => (holder.app as { $transaction: (fn: (tx: { $queryRaw: (q: TemplateStringsArray) => Promise<{ n: number }[]> }) => Promise<number>) => Promise<number> }).$transaction(async (tx) => (await tx.$queryRaw`SELECT count(*)::int AS n FROM "LoanDocumentIssuance"`)[0].n))
      expect(await count(stack.tenant)).toBeGreaterThan(0)
      expect(await count("some-other-tenant")).toBe(0)
    })

    it("another borrower cannot accept it", async () => {
      const id = `offer2-${t}`
      await flow.approvedApplication(id)
      const { offer } = await digests(id)
      asClient("someone-else")
      expect((await accept(post({ documentSha256: offer }), on(id))).status).toBe(403)
    })

    it("is required by the database: a raw signature with the statement acknowledged and the offer not accepted is refused", async () => {
      const id = `offer3-${t}`
      await flow.approvedApplication(id)
      const { kfs, agreement } = await digests(id)
      await db().loanDocumentIssuance.updateMany({ where: { applicationId: id, kind: "KEY_FACTS_STATEMENT" }, data: { acknowledgedAt: new Date(), acknowledgedById: `${id}-client`, acknowledgedSha256: kfs } })
      asClient(id)
      const res = await sign(post({ agreementDocumentSha256: agreement, signature: "Synthetic Borrower" }), on(id))
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(/offer letter has not been accepted/) })
      expect((await db().loanApplication.findUniqueOrThrow({ where: { id } })).agreementSignedAt).toBeNull()
    })

    it("cannot be acknowledged on the agreement: only the offer and the statement carry an acceptance", async () => {
      const id = `offer4-${t}`
      await flow.approvedApplication(id)
      const { agreement } = await digests(id)
      await expect(db().loanDocumentIssuance.updateMany({ where: { applicationId: id, kind: "LOAN_AGREEMENT" }, data: { acknowledgedAt: new Date(), acknowledgedById: `${id}-client`, acknowledgedSha256: agreement } })).rejects.toThrow(/acknowledgement_shape/)
    })

    it("approval stands when a template is not published: nothing is issued and staff are told why at the Issue button", async () => {
      const id = `noissue-${t}`
      const template = await db().documentTemplate.findFirstOrThrow({ where: { tenantId: stack.tenant, key: OFFER_KEY } })
      await db().documentTemplate.update({ where: { id: template.id }, data: { isActive: false } })
      await flow.approvedApplication(id)
      await db().documentTemplate.update({ where: { id: template.id }, data: { isActive: true } })
      expect(await db().loanApplication.findUniqueOrThrow({ where: { id } })).toMatchObject({ status: "APPROVED", agreementDocumentId: null })
      expect(await db().loanDocumentIssuance.count({ where: { applicationId: id } })).toBe(0)
    })

    it("on a demo stack a demo mailbox is simulated: nothing is sent and the audit row says so", async () => {
      vi.stubEnv("DEMO_MODE", "true")
      await db().emailConfig.update({ where: { tenantId: stack.tenant }, data: { active: false } })
      holder.sendEmail.mockClear()
      const id = `demo-${t}`
      await flow.approvedApplication(id)
      await db().emailConfig.update({ where: { tenantId: stack.tenant }, data: { active: true } })
      vi.stubEnv("DEMO_MODE", "false")
      expect(holder.sendEmail).not.toHaveBeenCalled()
      const notice = await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: id, action: "LOAN_DOCUMENT_NOTICE" } })
      expect(notice.newValue).toMatchObject({ legs: [{ channel: "EMAIL", outcome: "simulated" }] })
    })
  })

  describe("branch-assisted signing", () => {
    const attempt = async (id: string, over: Record<string, unknown> = {}) => {
      const d = await digests(id)
      asStaff()
      return branchSign(post({ witnessAttested: true, offerSha256: d.offer, keyFactsSha256: d.kfs, agreementDocumentSha256: d.agreement, signature: "Synthetic Borrower", ...over }), on(id))
    }
    const nothingRecorded = async (id: string) => {
      expect((await db().loanApplication.findUniqueOrThrow({ where: { id } })).agreementSignedAt).toBeNull()
      expect(await db().loanDocumentIssuance.count({ where: { applicationId: id, acknowledgedAt: { not: null } } })).toBe(0)
    }

    it("staff alone cannot do it: no code, a code not yet read back, another application's code, or no witness statement", async () => {
      const id = `branch-${t}`
      const other = `branch2-${t}`
      await flow.approvedApplication(id)
      await flow.approvedApplication(other)
      const { agreement } = await digests(id)
      expect((await attempt(id)).status).toBe(409)
      expect((await attempt(id, { signingOtpChallengeId: await verifiedCode(id, agreement, { verified: false }) })).status).toBe(409)
      expect((await attempt(id, { signingOtpChallengeId: await verifiedCode(other, (await digests(other)).agreement) })).status).toBe(409)
      expect((await attempt(id, { signingOtpChallengeId: await verifiedCode(id, agreement), witnessAttested: false })).status).toBe(422)
      await nothingRecorded(id)
    })

    it("a code from the other path does not sign: the borrower's portal code, or another witness's", async () => {
      const id = `branch5-${t}`
      await flow.approvedApplication(id)
      const { agreement } = await digests(id)
      const portal = await attempt(id, { signingOtpChallengeId: await verifiedCode(id, agreement, { requestedByUserId: null }) })
      expect(portal.status).toBe(409)
      expect(await portal.json()).toMatchObject({ signingOtp: "not_found" })
      expect((await attempt(id, { signingOtpChallengeId: await verifiedCode(id, agreement, { requestedByUserId: stack.senior }) })).status).toBe(409)
      await nothingRecorded(id)
    })

    it("a witness's code does not sign in the portal", async () => {
      const id = `branch6-${t}`
      await flow.approvedApplication(id)
      const d = await digests(id)
      asClient(id)
      expect((await accept(post({ documentSha256: d.offer }), on(id))).status).toBe(200)
      expect((await acknowledge(post({ documentSha256: d.kfs }), on(id))).status).toBe(200)
      holder.otpRequired = true
      const signed = await signKeyFactsAgreement({
        tenantId: stack.tenant, applicationId: id, clientId: `${id}-client`, clientEmail: null, agreementDocumentSha256: d.agreement, signature: "Synthetic Borrower",
        signingOtpChallengeId: await verifiedCode(id, d.agreement), ipAddress: "203.0.113.9",
      })
      holder.otpRequired = false
      expect(signed).toMatchObject({ ok: false, status: 409, signingOtp: "not_found" })
    })

    it("a name too long is refused before anything is written", async () => {
      const id = `branch7-${t}`
      await flow.approvedApplication(id)
      const { agreement } = await digests(id)
      expect((await attempt(id, { signature: "x".repeat(201), signingOtpChallengeId: await verifiedCode(id, agreement) })).status).toBe(422)
      await nothingRecorded(id)
    })

    it("a contact detail changed after approval sends the application back to review: the code cannot be pointed at someone else", async () => {
      const id = `branch8-${t}`
      await flow.approvedApplication(id)
      const { agreement } = await digests(id)
      await db().client.update({ where: { id: `${id}-client` }, data: { email: `${stack.officer}@test.invalid` } })
      expect((await attempt(id, { signingOtpChallengeId: await verifiedCode(id, agreement) })).status).toBe(409)
      await nothingRecorded(id)
      expect((await flow.decideForm(id, { action: "return_to_review", reason: "Synthetic: the borrower's contact details changed." })).status).toBe(200)
      expect((await db().loanApplication.findUniqueOrThrow({ where: { id } })).status).toBe("UNDER_REVIEW")
    })

    it("after a real change of address, review and re-approval, the code and the notice reach the new address and not the old", async () => {
      const id = `move-${t}`
      await flow.approvedApplication(id)
      await provisionContact(id)
      const clientId = `${id}-client`
      const before = await db().client.findUniqueOrThrow({ where: { id: clientId } })
      const moved = `moved-${t}@test.invalid`
      asStaff()
      const put = await putClient(new NextRequest("http://localhost/x", { method: "PUT", body: JSON.stringify({ email: moved, whatsapp: "+26658123456", expectedUpdatedAt: before.updatedAt.toISOString() }), headers: { "content-type": "application/json" } }), on(clientId))
      expect(put.status, await put.clone().text()).toBe(200)
      expect(await db().contact.findFirstOrThrow({ where: { clientId } })).toMatchObject({ primaryEmail: moved, primaryWaJid: "26658123456@s.whatsapp.net" })
      const identities = await db().contactIdentity.findMany({ where: { tenantId: stack.tenant, contact: { clientId }, channel: { in: ["EMAIL", "WHATSAPP"] } }, select: { value: true } })
      expect(identities.map((row) => row.value).sort()).toEqual(["26658123456@s.whatsapp.net", moved])
      // Before the review: no code goes to an address changed since the approval.
      const early = await requestCode(post({ purpose: "AGREEMENT", subjectId: id, documentSha256: (await digests(id)).agreement, channel: "EMAIL" }))
      expect(early.status).toBe(409)
      expect((await flow.decideForm(id, { action: "return_to_review", reason: "Synthetic: the borrower moved to a new mailbox." })).status).toBe(200)
      await clearOpenFlagsAgain(id)
      holder.sendEmail.mockClear()
      const res = await flow.decideForm(id, { action: "approve", repaymentMethod: "EFT" })
      expect(res.status, await res.clone().text()).toBe(200)
      expect(holder.sendEmail.mock.calls.map((call) => (call[0] as { to: string }).to)).toEqual([moved])
      const { agreement } = await digests(id)
      asStaff()
      // The officer typed that address: it takes someone else's confirmation before a code goes there.
      const unconfirmed = await requestCode(post({ purpose: "AGREEMENT", subjectId: id, documentSha256: agreement, channel: "EMAIL" }))
      expect(unconfirmed.status).toBe(409)
      expect(await unconfirmed.json()).toMatchObject({ signingOtp: "identity_unconfirmed" })
      const typed = await db().contactIdentity.findFirstOrThrow({ where: { tenantId: stack.tenant, channel: "EMAIL", value: moved } })
      await confirmContactIdentity({ tenantId: stack.tenant, clientId, identityId: typed.id, by: { id: stack.senior, email: "s@test.invalid", note: "Called the borrower back." } })
      const code = await requestCode(post({ purpose: "AGREEMENT", subjectId: id, documentSha256: agreement, channel: "EMAIL" }))
      expect(code.status, await code.clone().text()).toBe(200)
      expect((holder.sendEmail.mock.calls.at(-1)![0] as { to: string }).to).toBe(moved)
    })

    it("a Contact left stale by any other writer gets no notice, and the audit row says not sent", async () => {
      const id = `stale-${t}`
      await seedBorrower(db(), stack, id)
      await provisionContact(id)
      await db().client.update({ where: { id: `${id}-client` }, data: { email: `elsewhere-${t}@test.invalid` } })
      holder.sendEmail.mockClear()
      const legs = await runWithTenant(stack.tenant, () => deliverToBorrower({
        tenantId: stack.tenant, clientId: `${id}-client`, staff: { id: stack.officer, email: "o@test.invalid" }, entity: { type: "LoanApplication", id }, what: "loan documents",
        subject: "s", text: "t", operationId: operationIdFor(id),
      }))
      expect(legs[0]).toMatchObject({ channel: "EMAIL", outcome: "not_sent" })
      expect(holder.sendEmail).not.toHaveBeenCalled()
      const audit = await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: id, action: "LOAN_DOCUMENT_NOTICE" } })
      expect(audit.newValue).toMatchObject({ legs: [expect.objectContaining({ outcome: "not_sent" })] })
    })

    it("the witness cannot pay out that loan, with segregation of duties off, in the route or a raw write", async () => {
      const id = `branch9-${t}`
      await flow.approvedApplication(id)
      const { agreement } = await digests(id)
      const res = await attempt(id, { signingOtpChallengeId: await verifiedCode(id, agreement) })
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
      expect((await flow.verifyAccount(stack.confirmer, id)).status).toBe(200)
      await db().tenantConfig.update({ where: { tenantId: stack.tenant }, data: { requireSegregationOfDuties: false } })
      const witness = await flow.disburseAs(stack.officer, id)
      await db().tenantConfig.update({ where: { tenantId: stack.tenant }, data: { requireSegregationOfDuties: true } })
      expect(witness.status).toBe(422)
      expect(await witness.json()).toMatchObject({ disbursementPrecondition: "segregation_of_duties" })
      expect(await db().loan.count({ where: { applicationId: id } })).toBe(0)
      await expect(db().loanApplication.update({ where: { id }, data: { status: "DISBURSED", disbursedAt: new Date(), disbursedById: stack.officer } })).rejects.toThrow(/witness of the borrower/)
      expect((await flow.disburseAs(stack.disburser, id)).status).toBe(200)
    })

    it("a staff member has no path through the borrower's own routes", async () => {
      const id = `branch3-${t}`
      await flow.approvedApplication(id)
      const d = await digests(id)
      asStaff()
      expect((await accept(post({ documentSha256: d.offer }), on(id))).status).toBe(403)
      expect((await sign(post({ agreementDocumentSha256: d.agreement, signature: "Synthetic Borrower" }), on(id))).status).toBe(403)
      await nothingRecorded(id)
    })

    it("with the borrower's verified code everything lands as the borrower's, with staff recorded as the witness and the code spent", async () => {
      const id = `branch4-${t}`
      await flow.approvedApplication(id)
      const { agreement } = await digests(id)
      const challenge = await verifiedCode(id, agreement)
      const res = await attempt(id, { signingOtpChallengeId: challenge })
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(200)
      expect(await db().loanApplication.findUniqueOrThrow({ where: { id } })).toMatchObject({ agreementSignedMethod: "branch", agreementSignedByUserId: stack.officer, agreementSignatureData: "Synthetic Borrower" })
      const rows = await db().loanDocumentIssuance.findMany({ where: { applicationId: id, kind: { in: ["OFFER_LETTER", "KEY_FACTS_STATEMENT"] } } })
      expect(rows.map((r) => r.acknowledgedById)).toEqual([`${id}-client`, `${id}-client`])
      expect((await db().signingOtpChallenge.findUniqueOrThrow({ where: { id: challenge } })).signingMethod).toBe("branch")
      const audits = await db().auditLog.findMany({ where: { tenantId: stack.tenant, entityId: id, action: { in: ["LOAN_OFFER_ACCEPTED", "KEY_FACTS_ACKNOWLEDGED", "KEY_FACTS_AGREEMENT_SIGNED"] } } })
      expect(audits).toHaveLength(3)
      for (const audit of audits) expect(audit.newValue).toMatchObject({ actor: { type: "client", clientId: `${id}-client` }, assistedBy: { id: stack.officer } })
      expect((await attempt(id, { signingOtpChallengeId: challenge })).status).toBe(409)
    })
  })
})
