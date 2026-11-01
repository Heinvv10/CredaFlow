/**
 * The edges of PR C on real Postgres through the real routes, around ls-walk.integration.test.ts's happy path: what the database and
 * the routes refuse for the offer letter, the arrears letter, Section 129 on a key-facts loan and a signature at a branch.
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
  session: null as null | { user: Record<string, unknown> },
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
vi.mock("@/lib/signing-otp/policy", async (original) => ({ ...(await original<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => false }))
vi.mock("@/lib/config/identity", async (importOriginal) => {
  const identity = { legalName: "Demo Basotho Lending (Pty) Ltd", tradingName: "Demo Basotho Lending", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }
  return { ...(await importOriginal<typeof import("@/lib/config/identity")>()), findLenderIdentity: async () => identity, getLenderIdentity: async () => identity }
})

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { provisionContactForClient } from "@/lib/contact/provision"
import { hashSigningOtp } from "@/lib/signing-otp/code"
import { POST as accept } from "@/app/api/applications/[id]/loan-documents/accept/route"
import { POST as branchSign } from "@/app/api/applications/[id]/loan-documents/branch-sign/route"
import { POST as sign } from "@/app/api/applications/[id]/loan-documents/sign/route"
import { POST as arrearsLetter } from "@/app/api/loans/[id]/arrears-letter/route"
import { POST as section129 } from "@/app/api/loans/section129/route"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { AGREEMENT_KEY, KFS_KEY, OFFER_KEY, createTemplate, publishVersion, sha } from "./gate.integration-fixture"
import { ARREARS_LETTER_TEMPLATE_KEY } from "./keys"
import { lsFlow } from "./ls-flow.integration-fixture"
import { createRlsRole, seedStack, stackOf } from "./ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_lsletters_${t}`
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}}</p>`
const LETTER = "<h1>Arrears letter</h1><p>{{client.fullName}} {{loan.reference}} {{arrears.amount}} {{arrears.days}}</p>"
const LETTER_VERSION_REFUSED = /approved by someone other than its author/

let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
let letterTemplateId = ""
const db = () => fresh.db
const flow = lsFlow(db, stack, holder)
const post = (body?: unknown) => new NextRequest("http://localhost/x", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) })
const on = (id: string) => ({ params: Promise.resolve({ id }) })
const asClient = (id: string) => { holder.session = { user: { id: `${id}-client`, role: "CLIENT", email: `${id}@test.invalid`, tenantId: stack.tenant } } }
const asStaff = (userId = stack.officer, staffRole = "LOAN_ADMIN") => { holder.userId = userId; holder.role = staffRole; holder.session = { user: { id: userId, role: staffRole, email: `${userId}@test.invalid`, tenantId: stack.tenant } } }
const digests = async (id: string) => {
  const rows = await db().loanDocumentIssuance.findMany({ where: { applicationId: id, supersededAt: null } })
  const of = (kind: string) => rows.find((r) => r.kind === kind)!.pdfSha256
  return { offer: of("OFFER_LETTER"), kfs: of("KEY_FACTS_STATEMENT"), agreement: of("LOAN_AGREEMENT") }
}
const contactFor = async (id: string) => db().$transaction(async (tx) => {
  const c = await tx.client.findUniqueOrThrow({ where: { id: `${id}-client` } })
  await provisionContactForClient(tx as never, { tenantId: stack.tenant, clientId: c.id, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, whatsapp: c.whatsapp, source: "MANUAL" })
})
/** A code that reached the borrower and that they read back: what /api/signing-otp and its verify step leave behind. */
async function verifiedCode(id: string, documentSha256: string, over: { clientId?: string; subjectId?: string; verified?: boolean } = {}) {
  const challengeId = randomUUID()
  await db().signingOtpChallenge.create({
    data: {
      id: challengeId, tenantId: stack.tenant, clientId: over.clientId ?? `${id}-client`, purpose: "AGREEMENT", subjectId: over.subjectId ?? id, documentSha256,
      codeHash: hashSigningOtp(challengeId, "123456"), channel: "EMAIL", maskedDestination: "s***@test.invalid", expiresAt: new Date(Date.now() + 600_000),
      deliveryStatus: "ACCEPTED", sentAt: new Date(), verifiedAt: over.verified === false ? null : new Date(), requestedByUserId: stack.officer, attempts: 1, maxAttempts: 5,
    },
  })
  return challengeId
}
/** A loan in arrears: paid out through the routes, then the instalments' dates and the DPD columns as the nightly job would leave them. */
async function arrearsLoan(id: string) {
  await flow.signedApplication(id)
  expect((await flow.disburseAs(stack.disburser, id)).status).toBe(200)
  await contactFor(id)
  const loan = await db().loan.findUniqueOrThrow({ where: { applicationId: id } })
  await db().loan.update({ where: { id: loan.id }, data: { daysInArrears: 15, arrearsAmount: 120_000 } })
  return loan
}

suite("the letters and the branch (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "LTR", isDemoLender: true })
    for (const [key, title] of [[OFFER_KEY, "Offer letter"], [KFS_KEY, "Key facts statement"], [AGREEMENT_KEY, "Loan agreement"]] as const) await createTemplate(db(), stack.tenant, key, BODY(title))
    letterTemplateId = (await createTemplate(db(), stack.tenant, ARREARS_LETTER_TEMPLATE_KEY, LETTER)).templateId
    await db().emailConfig.create({ data: { tenantId: stack.tenant, fromName: "Demo Basotho Lending", fromAddress: "hello@basotho-lending.example" } })
    vi.stubEnv("TENANT_RLS", "on")
    vi.stubEnv("AUTH_SECRET", "synthetic-auth-secret-for-this-suite")
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

  describe("the arrears letter", () => {
    let loanId = ""
    let id = ""
    beforeAll(async () => {
      id = `arrears-${t}`
      loanId = (await arrearsLoan(id)).id
    }, 120_000)

    it("needs the collections permission, and arrears to collect", async () => {
      asStaff(stack.officer, "READONLY")
      expect((await arrearsLetter(post(), on(loanId))).status).toBe(403)
      const current = `current-${t}`
      await flow.signedApplication(current)
      expect((await flow.disburseAs(stack.disburser, current)).status).toBe(200)
      const loan = await db().loan.findUniqueOrThrow({ where: { applicationId: current } })
      asStaff()
      const res = await arrearsLetter(post(), on(loan.id))
      expect(res.status).toBe(422)
      expect(await db().loanArrearsLetter.count({ where: { loanId: loan.id } })).toBe(0)
    })

    it("refuses a template that is not published or whose approver wrote it; nothing is stored", async () => {
      const files = holder.files.size
      await db().documentTemplate.update({ where: { id: letterTemplateId }, data: { isActive: false } })
      asStaff()
      expect((await arrearsLetter(post(), on(loanId))).status).toBe(409)
      await db().documentTemplate.update({ where: { id: letterTemplateId }, data: { isActive: true } })
      const selfApproved = await publishVersion(db(), letterTemplateId, 2, LETTER)
      await db().documentTemplateVersion.update({ where: { id: selfApproved.id }, data: { approvedById: selfApproved.createdById } })
      const res = await arrearsLetter(post(), on(loanId))
      expect(res.status).toBe(409)
      expect(await res.json()).toMatchObject({ error: expect.stringMatching(LETTER_VERSION_REFUSED) })
      expect(await db().loanArrearsLetter.count({ where: { loanId } })).toBe(0)
      expect(holder.files.size).toBe(files)
      await publishVersion(db(), letterTemplateId, 3, LETTER)
    })

    it("refuses a deceased borrower", async () => {
      await db().client.update({ where: { id: `${id}-client` }, data: { deceasedAt: new Date() } })
      asStaff()
      expect((await arrearsLetter(post(), on(loanId))).status).toBe(409)
      await db().client.update({ where: { id: `${id}-client` }, data: { deceasedAt: null } })
    })

    it("issues once a day, from the current version, stored, kept and sent", async () => {
      asStaff()
      holder.sendEmail.mockClear()
      const res = await arrearsLetter(post(), on(loanId))
      const body = await res.json()
      expect(res.status, JSON.stringify(body)).toBe(201)
      expect(body).toMatchObject({ templateVersion: 3, sample: true })
      expect(holder.sendEmail).toHaveBeenCalledTimes(1)
      expect((await arrearsLetter(post(), on(loanId))).status).toBe(409)
      expect(await db().loanArrearsLetter.count({ where: { loanId } })).toBe(1)
      const row = await db().loanArrearsLetter.findFirstOrThrow({ where: { loanId } })
      await expect(db().loanArrearsLetter.update({ where: { id: row.id }, data: { arrearsAmount: 1 } })).rejects.toThrow(/cannot be changed or deleted/)
      await expect(db().loanArrearsLetter.delete({ where: { id: row.id } })).rejects.toThrow(/cannot be changed or deleted/)
      await expect(db().clientDocument.update({ where: { id: row.clientDocumentId }, data: { deletedAt: new Date() } })).rejects.toThrow(/cannot be deleted/)
      await expect(db().clientDocument.delete({ where: { id: row.clientDocumentId } })).rejects.toThrow(/cannot be deleted/)
    })

    it("the database refuses a forged letter: a draft version, or a document that is not this borrower's", async () => {
      const row = await db().loanArrearsLetter.findFirstOrThrow({ where: { loanId } })
      const { id: _id, issuedAt: _at, noticeDate: _day, sample: _sample, ...base } = row
      const tomorrow = new Date(Date.now() + 86_400_000)
      await expect(db().loanArrearsLetter.create({ data: { ...base, clientDocumentId: "nope", noticeDate: tomorrow } })).rejects.toThrow()
      const draft = await db().documentTemplateVersion.create({ data: { templateId: letterTemplateId, version: 9, bodyHtml: LETTER, tokensUsed: [], status: "DRAFT", createdById: "author-test" } })
      const document = await db().clientDocument.create({
        data: { tenantId: stack.tenant, clientId: `${id}-client`, docType: "OTHER", fileName: "f.pdf", fileUrl: "", storagePath: "/mem/f.pdf", fileSize: 1, mimeType: "application/pdf", templateId: letterTemplateId, generatedFromVersionId: draft.id, contentSha256: "e".repeat(64), extractionStatus: "skipped" },
      })
      await expect(db().loanArrearsLetter.create({ data: { ...base, templateVersionId: draft.id, templateVersionNumber: 9, clientDocumentId: document.id, pdfSha256: "e".repeat(64), noticeDate: tomorrow } })).rejects.toThrow(/current version of its template/)
    })

    it("Section 129 stays out of reach: the routes refuse, and the database refuses the record even if the code were fooled", async () => {
      asStaff()
      const res = await section129(post({ loanId }))
      expect(res.status).toBe(422)
      await expect(db().complianceRecord.create({ data: { tenantId: stack.tenant, type: "SECTION_129_NOTICE", referenceId: loanId, status: "PENDING" } })).rejects.toThrow(/key-facts loan has an arrears letter/)
      const other = await db().complianceRecord.create({ data: { tenantId: stack.tenant, type: "SECTION_129_NOTICE", referenceId: "no-such-loan", status: "PENDING" } })
      await expect(db().complianceRecord.update({ where: { id: other.id }, data: { referenceId: loanId } })).rejects.toThrow(/key-facts loan has an arrears letter/)
      await db().complianceRecord.delete({ where: { id: other.id } })
      expect(await db().complianceRecord.count({ where: { tenantId: stack.tenant, type: "SECTION_129_NOTICE" } })).toBe(0)
    })
  })
})

suite("South Africa is untouched (real Postgres, a ZA instance)", () => {
  let za: ThrowawayDb
  beforeAll(async () => { za = await createThrowawayDb() }, 300_000)
  afterAll(async () => { await za?.drop() }, 60_000)

  it("a ZA loan cannot be given an arrears letter, and its Section 129 record is not refused", async () => {
    const tenant = await createChargesTenant(za.db, false)
    const loan = await createChargesLoan(za.db, tenant)
    const template = await createTemplate(za.db, tenant.tenantId, ARREARS_LETTER_TEMPLATE_KEY, LETTER)
    const borrower = (await za.db.loan.findUniqueOrThrow({ where: { id: loan.loanId } })).clientId!
    const document = await za.db.clientDocument.create({
      data: { tenantId: tenant.tenantId, clientId: borrower, docType: "OTHER", fileName: "f.pdf", fileUrl: "", storagePath: "/mem/z.pdf", fileSize: 1, mimeType: "application/pdf", templateId: template.templateId, generatedFromVersionId: template.versionId, contentSha256: "d".repeat(64), extractionStatus: "skipped" },
    })
    await expect(za.db.loanArrearsLetter.create({
      data: {
        tenantId: tenant.tenantId, loanId: loan.loanId, templateId: template.templateId, templateVersionId: template.versionId, templateVersionNumber: 1, templateContentSha256: sha(LETTER), clientDocumentId: document.id, pdfSha256: "d".repeat(64),
        noticeDate: new Date(), arrearsAmount: 100, totalOutstanding: 100, daysInArrears: 1, issuedById: tenant.userId,
      },
    })).rejects.toThrow(/Section 129 notice/)
    expect(await za.db.complianceRecord.create({ data: { tenantId: tenant.tenantId, type: "SECTION_129_NOTICE", referenceId: loan.loanId, status: "PENDING" } })).toMatchObject({ referenceId: loan.loanId })
  })
})
