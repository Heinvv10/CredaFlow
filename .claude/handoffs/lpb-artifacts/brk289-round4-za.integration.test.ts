/**
 * Breaker rounds 1+2 on PR #289 (round 2 at cbdb0640). Real Postgres, real routes, an RLS-bound client. Each `it` asserts the SAFE
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
import { POST as resetPassword } from "@/app/api/portal/reset-password/route"
import { POST as forgotPassword } from "@/app/api/portal/forgot-password/route"
import { POST as requestOtp } from "@/app/api/signing-otp/route"
import { POST as verifyOtp } from "@/app/api/signing-otp/[id]/verify/route"
import { POST as sign } from "@/app/api/applications/[id]/loan-documents/sign/route"
import { POST as accept } from "@/app/api/applications/[id]/loan-documents/accept/route"
import { POST as issueDocs } from "@/app/api/applications/[id]/loan-documents/route"
import { POST as draftQuote } from "@/app/api/applications/[id]/key-facts-quote/route"
import { POST as startReview } from "@/app/api/applications/[id]/review/route"
import { PATCH as patchApplication } from "@/app/api/applications/[id]/route"
import { POST as branchSign } from "@/app/api/applications/[id]/loan-documents/branch-sign/route"
import { GET as documents } from "@/app/api/applications/[id]/loan-documents/route"
import { AGREEMENT_KEY, KFS_KEY, OFFER_KEY, createTemplate } from "./gate.integration-fixture"
import { ARREARS_LETTER_TEMPLATE_KEY } from "./keys"
import { lsFlow } from "./ls-flow.integration-fixture"
import { createRlsRole, seedBorrower, seedUnderReview, seedStack, stackOf } from "./ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("ZA", t)
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
  await db().client.update({ where: { id: clientId }, data: { phone: `+2782000${phoneSeq++}` } })
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
    fresh = await createThrowawayDb({ instance: { jurisdiction: "ZA", currency: "ZAR" } })
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


  const forgot = (email: string) => forgotPassword(req("/api/portal/forgot-password", "POST", { email, turnstileToken: "x" }))
  const otpRows = (email: string) => db().clientOtp.count({ where: { email } })
  it("T4 a client with no Contact: forgot still works, and a staff edit cannot recover the login through the new address", async () => {
    const id = `nc-${t}`; const clientId = `${id}-client`
    await seedBorrower(db(), stack, id)
    await db().client.update({ where: { id: clientId }, data: { portalPassword: "x".repeat(60) } })
    const own = `${id}@test.invalid`
    const first = await forgot(own)
    process.stderr.write(`T4 own ${first.status} otpRows=${await otpRows(own)}\n`)
    const contactless = await otpRows(own)
    asStaff(stack.officer)
    const before = await db().client.findUniqueOrThrow({ where: { id: clientId } })
    const rogue = `rogue-nc-${t}@test.invalid`
    const put = await putClient(req("/x", "PUT", { email: rogue, expectedUpdatedAt: before.updatedAt.toISOString() }), on(clientId))
    expect(put.status, await put.clone().text()).toBe(200)
    const after = await forgot(rogue)
    process.stderr.write(`T4 rogue ${after.status} otpRows=${await otpRows(rogue)}\n`)
    const otp = await db().clientOtp.findFirstOrThrow({ where: { email: rogue } })
    const reset = await resetPassword(req("/api/portal/reset-password", "POST", { email: rogue, otp: otp.otp, password: "Synthetic-Pass-Word-9!", confirmPassword: "Synthetic-Pass-Word-9!" }))
    process.stderr.write(`T4 reset ${reset.status} ${(await reset.clone().text()).slice(0, 100)} changed=${(await db().client.findUniqueOrThrow({ where: { id: clientId } })).portalPassword !== "x".repeat(60)}\n`)
    expect.soft(contactless, "a contactless client lost login recovery").toBe(1)
    expect(await otpRows(rogue), "a staff-typed address on a client with no Contact recovers the login").toBe(0)
  })

  it("ZA: a staff edit of the address must not route the NCA branch code to it", async () => {
    const id = `za1-${t}`; const clientId = `${id}-client`
    await seedUnderReview(db(), stack, id, { nca: true })
    await provision(clientId)
    const doc = await db().clientDocument.create({ data: { tenantId: stack.tenant, clientId, docType: "CREDIT_AGREEMENT", fileUrl: "/synthetic/a", fileName: "a.pdf", fileSize: 1, mimeType: "application/pdf", contentSha256: "a".repeat(64), storagePath: "/mem/a.pdf", extractionStatus: "skipped", uploadedByType: "staff", issuedForApplicationId: id } })
    const sha = "a".repeat(64)
    await db().$executeRawUnsafe(`ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_approved_status_requires_pasq"`) // throwaway DB: only to reach the OTP route
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`UPDATE "LoanApplication" SET "status" = 'APPROVED', "repaymentMethod" = 'EFT', "agreementDocumentSha256" = '${sha}', "agreementDocumentId" = '${doc.id}', "agreementGeneratedAt" = now(), "approvedById" = '${stack.officer}' WHERE "id" = '${id}'`)
    })
    const ident = (await db().contact.findFirstOrThrow({ where: { clientId } }))
    process.stderr.write(`ZA contact before ${ident.primaryEmail}\n`)
    const rogue = `rogue-za-${t}@test.invalid`
    asStaff(stack.officer)
    const before = await db().client.findUniqueOrThrow({ where: { id: clientId } })
    const put = await putClient(req("/x", "PUT", { email: rogue, expectedUpdatedAt: before.updatedAt.toISOString() }), on(clientId))
    expect(put.status, await put.clone().text()).toBe(200)
    holder.portalOtp = true // signingOtpBranchExempt off: the lender requires the borrower's code at a branch
    holder.sendEmail.mockClear()
    const r = await requestOtp(req("/api/signing-otp", "POST", { purpose: "AGREEMENT", subjectId: id, documentSha256: sha, channel: "EMAIL" }))
    holder.portalOtp = false
    const to = (holder.sendEmail.mock.calls.at(-1)?.[0] as { to?: string } | undefined)?.to
    process.stderr.write(`ZA otp ${r.status} ${(await r.clone().text()).slice(0, 120)} to-rogue=${to === rogue}\n`)
    expect(to).not.toBe(rogue)
  })
})
