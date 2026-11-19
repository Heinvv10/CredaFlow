/**
 * Breaker round 1 on PR #289 (879097a6). Real Postgres, real routes, an RLS-bound client. Each `it` asserts the SAFE
 * behaviour, so a red test is a finding. Everything synthetic.
 *   RUN_DB_IT=1 DATABASE_URL=... npx vitest run lib/non-nca-documents/brk289.integration.test.ts
 * Copy into lib/non-nca-documents/ of a checkout of the PR to run it (it uses that directory's fixtures).
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({
  app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN", files: new Map<string, Buffer>(),
  session: null as null | { user: Record<string, unknown> }, portalOtp: false, realEmail: null as null | ((...a: unknown[]) => Promise<unknown>),
  sendEmail: vi.fn(async (..._args: unknown[]) => ({ ok: true, messageId: `provider-${Math.random()}`, provider: "SMTP", providerOutcome: "ACCEPTED", acceptedAt: new Date() })),
}))
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, { get(_t, key) { if (!holder.app) throw new Error("no app client"); const v: unknown = Reflect.get(holder.app, key); return typeof v === "function" ? v.bind(holder.app) : v } })
  return { ...actual, prisma }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => holder.session) }))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: vi.fn(async () => ({ user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: holder.role, tenantId: holder.tenantId, totpVerified: true } })),
}))
vi.mock("@/lib/tenant", async (importOriginal) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  const tenant = () => ({ id: holder.tenantId, slug: holder.tenantId, name: "brk", domain: null, status: "ACTIVE" })
  return {
    ...(await importOriginal<typeof import("@/lib/tenant")>()),
    getTenantFromRequest: async () => tenant(),
    withTenantContext: (_req: unknown, handler: (t: object) => Promise<unknown>) => runWithTenant(holder.tenantId, () => handler(tenant())),
    withTenantContextLoggingRefusal: (_req: unknown, _c: unknown, handler: (t: object) => Promise<unknown>) => runWithTenant(holder.tenantId, () => handler(tenant())),
  }
})
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => ({ failedLegs: [] })) }))
vi.mock("@/lib/email/service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/email/service")>()), realSendEmailForBrk: (await importOriginal<typeof import("@/lib/email/service")>()).sendEmail, sendEmail: (...a: unknown[]) => (holder.realEmail ? holder.realEmail(...a) : holder.sendEmail(...a)) }))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  saveFile: async (buffer: Buffer) => { const path = `/mem/${holder.files.size}-${Math.random()}.pdf`; holder.files.set(path, buffer); return { storagePath: path, fileSize: buffer.length } },
  readFile: async (path: string) => { const b = holder.files.get(path); if (!b) throw new Error("missing"); return b },
  deleteFile: async (path: string) => { holder.files.delete(path) },
}))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (html: string) => Buffer.from(`%PDF-synthetic ${html} ${randomUUID()}`) }))
vi.mock("@/lib/signing-otp/policy", async (original) => ({ ...(await original<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => holder.portalOtp }))
vi.mock("@/lib/turnstile", () => ({ verifyTurnstile: async () => ({ ok: true }) }))
vi.mock("@/lib/config/identity", async (importOriginal) => {
  const identity = { legalName: "Demo Basotho Lending (Pty) Ltd", tradingName: "Demo Basotho Lending", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }
  return { ...(await importOriginal<typeof import("@/lib/config/identity")>()), findLenderIdentity: async () => identity, getLenderIdentity: async () => identity }
})

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { provisionContactForClient } from "@/lib/contact/provision"
import { POST as website } from "@/app/api/website/apply/route"
import { POST as portalApply } from "@/app/api/portal/applications/route"
import { POST as quoteKeyFacts } from "@/app/api/portal/key-facts-quote/route"
import { DELETE as deleteDocument } from "@/app/api/documents/[id]/route"
import { PUT as putClient } from "@/app/api/clients/[id]/route"
import { POST as requestOtp } from "@/app/api/signing-otp/route"
import { POST as verifyOtp } from "@/app/api/signing-otp/[id]/verify/route"
import { POST as branchSign } from "@/app/api/applications/[id]/loan-documents/branch-sign/route"
import { GET as documents } from "@/app/api/applications/[id]/loan-documents/route"
import { AGREEMENT_KEY, KFS_KEY, OFFER_KEY, createTemplate } from "./gate.integration-fixture"
import { ARREARS_LETTER_TEMPLATE_KEY } from "./keys"
import { lsFlow } from "./ls-flow.integration-fixture"
import { createRlsRole, seedBorrower, seedStack, stackOf } from "./ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_brk_${t}`
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`
const PRODUCT_CODE = "BRK-PERSONAL"

let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const flow = lsFlow(db, stack, holder)
const asClient = (clientId: string) => { holder.session = { user: { id: clientId, role: "CLIENT", email: `${clientId.replace(/-client$/, "")}@test.invalid`, tenantId: stack.tenant } } }
const asStaff = (userId: string, staffRole = "LOAN_ADMIN") => { holder.userId = userId; holder.role = staffRole; holder.session = { user: { id: userId, role: staffRole, email: `${userId}@test.invalid`, tenantId: stack.tenant } } }
const req = (url: string, method: string, body?: unknown) => new NextRequest(`http://localhost${url}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json" } }) })
const on = (id: string) => ({ params: Promise.resolve({ id }) })

let phoneSeq = 1000
async function provision(clientId: string) {
  await db().client.update({ where: { id: clientId }, data: { phone: `+2665800${phoneSeq++}` } })
  await db().$transaction((tx) => db().client.findUniqueOrThrow({ where: { id: clientId } }).then((c) => provisionContactForClient(tx as never, {
    tenantId: stack.tenant, clientId, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, whatsapp: c.whatsapp, source: "MANUAL",
  })))
}
async function shas(applicationId: string) {
  const res = await documents(new NextRequest("http://localhost/x"), on(applicationId))
  const state = await res.json()
  const sha = (kind: string): string => state.documents.find((d: { kind: string }) => d.kind === kind).pdfSha256
  return { offer: sha("OFFER_LETTER"), kfs: sha("KEY_FACTS_STATEMENT"), agreement: sha("LOAN_AGREEMENT") }
}
const codeFromLastEmail = () => /\b(\d{6})\b/.exec(JSON.stringify(holder.sendEmail.mock.calls.at(-1)?.[0]))?.[1] ?? ""

/** The branch ceremony through the routes, driven by `witness`. */
async function branchCeremony(applicationId: string, witness: string, signature = "Synthetic Borrower") {
  asClient(`${applicationId}-client`)
  const docs = await shas(applicationId)
  asStaff(witness)
  const reqd = await requestOtp(req("/api/signing-otp", "POST", { purpose: "AGREEMENT", subjectId: applicationId, documentSha256: docs.agreement, channel: "EMAIL" }))
  const body = await reqd.json()
  expect(reqd.status, JSON.stringify(body)).toBe(200)
  const challengeId: string = body.challengeId ?? body.id
  expect((await verifyOtp(req("/x", "POST", { code: codeFromLastEmail() }), on(challengeId))).status).toBe(200)
  const res = await branchSign(req("/x", "POST", {
    witnessAttested: true, offerSha256: docs.offer, keyFactsSha256: docs.kfs, agreementDocumentSha256: docs.agreement, signature, signingOtpChallengeId: challengeId,
  }), on(applicationId))
  return { res, challengeId, docs }
}

suite("breaker round 1 on PR 289", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "BRK", isDemoLender: false })
    await db().loanProduct.create({
      data: {
        tenantId: stack.tenant, code: PRODUCT_CODE, name: "Personal Loan", productType: "PERSONAL", minAmount: 100_000, maxAmount: 2_000_000, minTermDays: 90, maxTermDays: 360,
        interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900,
      },
    })
    for (const [key, title] of [[OFFER_KEY, "Offer letter"], [KFS_KEY, "Key facts statement"], [AGREEMENT_KEY, "Loan agreement"]] as const) await createTemplate(db(), stack.tenant, key, BODY(title))
    await createTemplate(db(), stack.tenant, ARREARS_LETTER_TEMPLATE_KEY, "<p>{{arrears.amount}}</p>")
    await db().emailConfig.create({ data: { tenantId: stack.tenant, fromName: "Demo", fromAddress: "hello@basotho-lending.example" } })
    vi.stubEnv("TENANT_RLS", "on"); vi.stubEnv("AUTH_SECRET", "synthetic-auth-secret-for-this-suite-only-000000"); vi.stubEnv("UNSUB_TOKEN_SECRET", "synthetic-unsub-secret-for-this-suite-only-00000"); vi.stubEnv("NEXTAUTH_URL", "http://localhost:3000")
    app = createAppPrismaClient(await createRlsRole(db(), fresh.url, role))
    holder.app = app
    resetActiveJurisdiction(); resetEnsuredJurisdiction()
    await ensureActiveJurisdiction(app as never)
  }, 300_000)

  afterAll(async () => {
    vi.unstubAllEnvs(); holder.app = null
    await app?.$disconnect()
    await fresh?.db.$executeRawUnsafe(`DROP OWNED BY ${role}`).catch(() => undefined)
    await fresh?.drop()
    const admin = new PrismaClient()
    await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined)
    await admin.$disconnect()
    resetActiveJurisdiction(); resetEnsuredJurisdiction()
  }, 60_000)

  it("F1 the branch witness cannot also pay out", async () => {
    const id = `w1-${t}`
    await flow.approvedApplication(id)
    await provision(`${id}-client`)
    const { res } = await branchCeremony(id, stack.disburser)
    expect(res.status, await res.clone().text()).toBe(200)
    expect(await db().loanApplication.findUniqueOrThrow({ where: { id } })).toMatchObject({ agreementSignedMethod: "branch", agreementSignedByUserId: stack.disburser })
    expect((await flow.verifyAccount(stack.officer, id)).status).toBe(200)
    const paid = await flow.disburseAs(stack.disburser, id)
    expect(paid.status, await paid.clone().text()).toBe(422)
  })

  it("F2 the public website cannot create a key-facts application with no pre-submission statement", async () => {
    const email = `web-${t}@test.invalid`
    const res = await website(req("/api/website/apply", "POST", {
      firstName: "Web", lastName: "Applicant", email, phone: "+26658000099", idNumber: "990000077", employmentStatus: "EMPLOYED", employerName: "Demo Employer",
      monthlyIncome: 30000, monthlyExpenses: 9000, productType: "PERSONAL", amount: 6000, termDays: 180, purpose: "School fees", turnstileToken: "x", popiaConsent: true,
    }))
    const body = await res.clone().text()
    const made = await db().loanApplication.findMany({ where: { tenantId: stack.tenant, client: { email } }, select: { id: true, status: true, disclosureRegime: true } })
    process.stderr.write(`F2 ${JSON.stringify(made)}\n`)
    expect(made, `status ${res.status}: ${body}`).toEqual([])
  })

  it("F3 the indicative statement proving tender 2.2.4 survives submission", async () => {
    const id = `pre-${t}`; const clientId = `${id}-client`
    const { statement } = await seedBorrower(db(), stack, id); holder.files.set(statement.path, statement.bytes)
    await provision(clientId)
    asClient(clientId)
    const form = { productCode: PRODUCT_CODE, amount: 6000, termDays: 180, purpose: "School fees" }
    const quote = await (await quoteKeyFacts(req("/api/portal/key-facts-quote", "POST", form))).json()
    const applied = await portalApply(req("/api/portal/applications", "POST", { ...form, keyFactsDocumentSha256: quote.sha256 }))
    expect(applied.status, await applied.clone().text()).toBe(201)
    // The borrower, through the ordinary delete route.
    const del = await deleteDocument(req(`/api/documents/${quote.documentId}`, "DELETE"), on(quote.documentId))
    const after = await db().clientDocument.findUniqueOrThrow({ where: { id: quote.documentId } })
    process.stderr.write(`F3-delete ${del.status} ${await del.clone().text()}\n`)
    expect(after.deletedAt, `route said ${del.status}: ${await del.clone().text()}`).toBeNull()
  })

  it("F3b the database itself refuses to delete or swap a claimed statement", async () => {
    const doc = await db().clientDocument.findFirstOrThrow({ where: { tenantId: stack.tenant, fileName: { startsWith: "key-facts-indicative" }, issuedForApplicationId: { not: null } } })
    await expect(db().clientDocument.update({ where: { id: doc.id }, data: { contentSha256: "0".repeat(64) } })).rejects.toThrow()
  })

  it("F4 staff alone cannot redirect the borrower's code to themselves", async () => {
    const id = `otp-${t}`; const clientId = `${id}-client`
    await flow.approvedApplication(id)
    await provision(clientId)
    asStaff(stack.officer)
    const rogue = `rogue-${t}@test.invalid`
    const before = await db().client.findUniqueOrThrow({ where: { id: clientId } })
    const patched = await putClient(req(`/api/clients/${clientId}`, "PUT", { email: rogue, expectedUpdatedAt: before.updatedAt.toISOString() }), on(clientId))
    const patchedBody = (await patched.clone().text()).slice(0, 200)
    holder.sendEmail.mockClear()
    asClient(clientId)
    holder.session!.user.email = rogue
    const docs = await shas(id)
    asStaff(stack.officer)
    const reqd = await requestOtp(req("/api/signing-otp", "POST", { purpose: "AGREEMENT", subjectId: id, documentSha256: docs.agreement, channel: "EMAIL" }))
    const body = await reqd.clone().json()
    const sentTo = (holder.sendEmail.mock.calls.at(-1)?.[0] as { to?: string } | undefined)?.to
    process.stderr.write(`F4 put ${patched.status} ${patchedBody} | otp ${reqd.status} ${JSON.stringify(body)} | sentTo=${sentTo}\n`)
    if (reqd.status === 200 && sentTo === rogue) {
      expect((await verifyOtp(req("/x", "POST", { code: codeFromLastEmail() }), on(body.challengeId))).status).toBe(200)
      const signed = await branchSign(req("/x", "POST", { witnessAttested: true, offerSha256: docs.offer, keyFactsSha256: docs.kfs, agreementDocumentSha256: docs.agreement, signature: "Synthetic Borrower", signingOtpChallengeId: body.challengeId }), on(id))
      process.stderr.write(`F4 branchSign ${signed.status} ${await signed.clone().text()}\n`)
      expect((await db().loanApplication.findUniqueOrThrow({ where: { id } })).agreementSignedAt, "staff signed alone").toBeNull()
    }
    expect(sentTo).not.toBe(rogue)
  })

  it("F5 a code the borrower verified in the portal cannot be spent by a branch witness", async () => {
    const id = `xchan-${t}`; const clientId = `${id}-client`
    await flow.approvedApplication(id)
    await provision(clientId)
    holder.portalOtp = true
    asClient(clientId)
    const docs = await shas(id)
    const r = await requestOtp(req("/api/signing-otp", "POST", { purpose: "AGREEMENT", subjectId: id, documentSha256: docs.agreement, channel: "EMAIL" }))
    const b = await r.json(); expect(r.status, JSON.stringify(b)).toBe(200)
    const challengeId: string = b.challengeId ?? b.id
    expect((await verifyOtp(req("/x", "POST", { code: codeFromLastEmail() }), on(challengeId))).status).toBe(200)
    holder.portalOtp = false
    asStaff(stack.officer)
    const res = await branchSign(req("/x", "POST", { witnessAttested: true, offerSha256: docs.offer, keyFactsSha256: docs.kfs, agreementDocumentSha256: docs.agreement, signature: "Synthetic Borrower", signingOtpChallengeId: challengeId }), on(id))
    expect(res.status, await res.clone().text()).not.toBe(200)
  })

  it("F6 a refused branch signature writes no acceptance", async () => {
    const id = `long-${t}`; const clientId = `${id}-client`
    await flow.approvedApplication(id)
    await provision(clientId)
    const { res } = await branchCeremony(id, stack.officer, "x".repeat(201))
    expect(res.status).toBe(422)
    expect(await db().loanDocumentIssuance.count({ where: { applicationId: id, acknowledgedAt: { not: null } } })).toBe(0)
  })

  it("H1 no provider, not demo: the notice says not sent and never claims delivery", async () => {
    const id = `noprov-${t}`; const clientId = `${id}-client`
    const actual = await vi.importActual<typeof import("@/lib/email/service")>("@/lib/email/service")
    await db().emailConfig.deleteMany({ where: { tenantId: stack.tenant } })
    holder.realEmail = actual.sendEmail as never
    try {
      await flow.approvedApplication(id)
      await provision(clientId)
      await flow.as(stack.officer)
      const { issueLoanDocuments } = await import("./issue")
      const { runWithTenant } = await import("@/lib/tenant-scope")
      const issued = await runWithTenant(stack.tenant, () => issueLoanDocuments({ tenantId: stack.tenant, applicationId: id, staff: { id: stack.officer, email: "o@test.invalid" } }))
      expect(issued).toMatchObject({ ok: true })
      const notices = await db().auditLog.findMany({ where: { tenantId: stack.tenant, entityId: id, action: "LOAN_DOCUMENT_NOTICE" }, orderBy: { createdAt: "desc" } })
      process.stderr.write(`H1 ${JSON.stringify(notices.map((n) => n.newValue))}\n`)
      expect(JSON.stringify(notices[0].newValue)).toContain("not_sent")
    } finally {
      holder.realEmail = null
      await db().emailConfig.create({ data: { tenantId: stack.tenant, fromName: "Demo", fromAddress: "hello@basotho-lending.example" } })
    }
  })

  it("G1 a code is spent once", async () => {
    const id = `once-${t}`; const clientId = `${id}-client`
    await flow.approvedApplication(id)
    await provision(clientId)
    const { res, challengeId, docs } = await branchCeremony(id, stack.officer)
    expect(res.status).toBe(200)
    const again = await branchSign(req("/x", "POST", { witnessAttested: true, offerSha256: docs.offer, keyFactsSha256: docs.kfs, agreementDocumentSha256: docs.agreement, signature: "Again Again", signingOtpChallengeId: challengeId }), on(id))
    expect(again.status).toBe(409)
    expect((await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: id, action: "KEY_FACTS_AGREEMENT_SIGNED" } })).newValue).toMatchObject({ method: "branch", otp: true, actor: { type: "client", clientId }, assistedBy: { id: stack.officer } })
  })
})
