/**
 * The whole of a Lesotho loan through the routes people use, on real Postgres, with no session_replication_role shortcut:
 * the borrower applies in the portal, having read the indicative key facts statement; staff review and approve, which issues
 * the three documents and tells the borrower; the borrower accepts, acknowledges and signs in the portal; a second person
 * confirms the account and a second officer pays out; the first instalment is paid; the clock moves past the second one, the DPD
 * job runs, and collections issues the arrears letter from the lender's template. Section 129 stays out of reach throughout.
 *
 * Only the clock moves: the dates come from the schedule the loan was booked on, so this holds on any day of the month.
 * Mocked: the session, the tenant frame, the RLS-bound client (createAppPrismaClient is real), the PDF renderer (the HTML is the
 * "PDF", so what was printed can be read), file storage and the email transport: nothing leaves.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/non-nca-documents/ls-walk.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"

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
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Lesotho walk IT", domain: null, status: "ACTIVE" })),
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
import { sastCalendarDate } from "@/lib/date/sast"
import { formatZAR } from "@/lib/utils"
import { POST as apply } from "@/app/api/portal/applications/route"
import { POST as quoteKeyFacts } from "@/app/api/portal/key-facts-quote/route"
import { POST as review } from "@/app/api/applications/[id]/review/route"
import { POST as accept } from "@/app/api/applications/[id]/loan-documents/accept/route"
import { POST as acknowledge } from "@/app/api/applications/[id]/loan-documents/acknowledge/route"
import { GET as documents } from "@/app/api/applications/[id]/loan-documents/route"
import { POST as sign } from "@/app/api/applications/[id]/loan-documents/sign/route"
import { POST as capturePayment } from "@/app/api/payments/route"
import { GET as dpdCron } from "@/app/api/cron/dpd-update/route"
import { POST as arrearsLetter } from "@/app/api/loans/[id]/arrears-letter/route"
import { POST as section129 } from "@/app/api/loans/section129/route"
import { AGREEMENT_KEY, KFS_KEY, OFFER_KEY, createTemplate } from "./gate.integration-fixture"
import { ARREARS_LETTER_TEMPLATE_KEY } from "./keys"
import { bankRefFor, lsFlow } from "./ls-flow.integration-fixture"
import { clearOpenFlags, createRlsRole, seedBorrower, seedStack, stackOf } from "./ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_lswalk_${t}`
const id = `walk-${t}`
const clientId = `${id}-client`
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`
const LETTER = "<h1>Arrears letter</h1><p>{{client.fullName}} {{loan.reference}} {{arrears.amount}} {{arrears.days}} {{arrears.totalOutstanding}} {{arrears.noticeDate}}</p>"
const CRON_SECRET = "synthetic-cron-secret-for-this-suite"
const PRODUCT_CODE = "LS-PERSONAL"
const AMOUNT_MALOTI = 6_000
const TERM_DAYS = 180

let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const flow = lsFlow(db, stack, holder)
const printedLast = () => [...holder.files.values()].at(-1)!.toString()

const asClient = () => { holder.session = { user: { id: clientId, role: "CLIENT", email: `${id}@test.invalid`, tenantId: stack.tenant } } }
const asStaff = (userId: string, staffRole = "LOAN_ADMIN") => { holder.userId = userId; holder.role = staffRole; holder.session = { user: { id: userId, role: staffRole, email: `${userId}@test.invalid`, tenantId: stack.tenant } } }
const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }) })
const on = (applicationId: string) => ({ params: Promise.resolve({ id: applicationId }) })
const ok = async (res: Response, status = 200) => { const body = await res.clone().json(); expect(res.status, JSON.stringify(body)).toBe(status); return body }

suite("a Lesotho loan, apply to arrears letter (real Postgres, real routes, no bypass)", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "WLK", isDemoLender: true })
    await db().loanProduct.create({
      data: {
        tenantId: stack.tenant, code: PRODUCT_CODE, name: "Personal Loan", productType: "PERSONAL", minAmount: 100_000, maxAmount: 2_000_000, minTermDays: 90, maxTermDays: 360,
        interestRatePm: 0.02, interestModel: "REDUCING_BALANCE", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6_900,
      },
    })
    for (const [key, title] of [[OFFER_KEY, "Offer letter"], [KFS_KEY, "Key facts statement"], [AGREEMENT_KEY, "Loan agreement"]] as const) await createTemplate(db(), stack.tenant, key, BODY(title))
    await createTemplate(db(), stack.tenant, ARREARS_LETTER_TEMPLATE_KEY, LETTER)
    // A real tenant's mail settings; the transport under them is the double above, so nothing leaves.
    await db().emailConfig.create({ data: { tenantId: stack.tenant, fromName: "Demo Basotho Lending", fromAddress: "hello@basotho-lending.example" } })
    const { statement } = await seedBorrower(db(), stack, id)
    holder.files.set(statement.path, statement.bytes)
    await db().$transaction((tx) => db().client.findUniqueOrThrow({ where: { id: clientId } }).then((c) => provisionContactForClient(tx as never, {
      tenantId: stack.tenant, clientId, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, whatsapp: c.whatsapp, source: "MANUAL",
    })))
    vi.stubEnv("TENANT_RLS", "on")
    vi.stubEnv("CRON_SECRET", CRON_SECRET)
    app = createAppPrismaClient(await createRlsRole(db(), fresh.url, role))
    holder.app = app
    resetActiveJurisdiction()
    resetEnsuredJurisdiction()
    await ensureActiveJurisdiction(app as never)
  }, 300_000)

  afterEach(() => { vi.useRealTimers() })

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

  it("applies, approves, signs, disburses, repays and gets an arrears letter, each step by the person whose step it is", async () => {
    // 1. Apply. Not without the key facts statement for these terms; then with it.
    asClient()
    const form = { productCode: PRODUCT_CODE, amount: AMOUNT_MALOTI, termDays: TERM_DAYS, purpose: "School fees" }
    const unread = await apply(post("/api/portal/applications", form))
    expect(unread.status).toBe(422)
    expect(await unread.json()).toMatchObject({ keyFacts: "required" })
    const otherTerm = await ok(await quoteKeyFacts(post("/api/portal/key-facts-quote", { ...form, termDays: 270 })), 201)
    expect((await apply(post("/api/portal/applications", { ...form, keyFactsDocumentSha256: otherTerm.sha256 }))).status).toBe(422)
    const quote = await ok(await quoteKeyFacts(post("/api/portal/key-facts-quote", form)), 201)
    expect(printedLast()).toContain("INDICATIVE")
    expect(printedLast()).toContain("SAMPLE")
    expect(printedLast()).toContain("M 6,000.00")
    const applied = await ok(await apply(post("/api/portal/applications", { ...form, keyFactsDocumentSha256: quote.sha256 })), 201)
    const applicationId: string = applied.applicationId ?? applied.id
    expect(await db().clientDocument.findUniqueOrThrow({ where: { id: quote.documentId } })).toMatchObject({ issuedForApplicationId: applicationId })
    expect(await db().loanApplication.findUniqueOrThrow({ where: { id: applicationId } })).toMatchObject({ disclosureRegime: "KEY_FACTS", status: "SUBMITTED" })

    // 2. Approve: staff review, clear the findings, a loan admin decides. The documents issue with the approval, and the borrower is told.
    asStaff(stack.officer)
    await ok(await review(post(`/api/applications/${applicationId}/review`, {}, { accept: "application/json" }), on(applicationId)))
    await clearOpenFlags(db(), stack, applicationId)
    await ok(await flow.decideForm(applicationId, { action: "approve", repaymentMethod: "EFT" }))
    expect(await db().loanDocumentIssuance.count({ where: { applicationId, supersededAt: null } })).toBe(3)
    const notice = await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: applicationId, action: "LOAN_DOCUMENT_NOTICE" } })
    expect(notice.newValue).toMatchObject({ what: "loan documents", legs: [expect.objectContaining({ channel: "EMAIL", outcome: "sent" })] })
    expect(holder.sendEmail).toHaveBeenCalledTimes(1)
    expect(holder.sendEmail.mock.calls[0][0]).toMatchObject({ to: `${id}@test.invalid`, subject: expect.stringContaining("loan documents") })

    // 3. Sign: staff have no path; the borrower accepts, acknowledges and signs, on the digests they were shown.
    await flow.attestKyc(id)
    const state = await ok(await documents(new NextRequest("http://localhost/x"), on(applicationId)))
    const sha = (kind: string): string => state.documents.find((d: { kind: string }) => d.kind === kind).pdfSha256
    asStaff(stack.officer)
    expect((await accept(post("/x", { documentSha256: sha("OFFER_LETTER") }), on(applicationId))).status).toBe(403)
    expect((await sign(post("/x", { agreementDocumentSha256: sha("LOAN_AGREEMENT"), signature: "Synthetic Borrower" }), on(applicationId))).status).toBe(403)
    asClient()
    await ok(await acknowledge(post("/x", { documentSha256: sha("KEY_FACTS_STATEMENT") }), on(applicationId)))
    const unaccepted = await sign(post("/x", { agreementDocumentSha256: sha("LOAN_AGREEMENT"), signature: "Synthetic Borrower" }), on(applicationId))
    expect(unaccepted.status).toBe(409)
    expect(await unaccepted.json()).toMatchObject({ error: expect.stringMatching(/offer letter has not been accepted/) })
    await ok(await accept(post("/x", { documentSha256: sha("OFFER_LETTER") }), on(applicationId)))
    await ok(await sign(post("/x", { agreementDocumentSha256: sha("LOAN_AGREEMENT"), signature: "Synthetic Borrower" }), on(applicationId)))
    expect(await db().auditLog.count({ where: { tenantId: stack.tenant, entityId: applicationId, action: { in: ["LOAN_OFFER_ACCEPTED", "KEY_FACTS_ACKNOWLEDGED", "KEY_FACTS_AGREEMENT_SIGNED"] } } })).toBe(3)

    // 4. Disburse: a second person confirms the account, a second officer records the manual transfer.
    expect((await flow.verifyAccount(stack.officer, applicationId)).status).toBe(200)
    const booked = await ok(await flow.disburseAs(stack.disburser, applicationId))
    expect(booked).toMatchObject({ payout: { channel: "MANUAL" } })
    const loan = await db().loan.findUniqueOrThrow({ where: { applicationId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
    expect(loan).toMatchObject({ status: "ACTIVE", principal: 600_000, creditLifePremiums: 0 })
    expect(loan.repaymentSchedule.length).toBeGreaterThanOrEqual(3)
    expect((await db().loanApplication.findUniqueOrThrow({ where: { id: applicationId } })).disbursementRef).toBe(bankRefFor(applicationId))

    // 5. Repay: the first instalment, captured by collections.
    const [first, second] = loan.repaymentSchedule
    asStaff(stack.officer)
    const receipt = await capturePayment(post("/api/payments", { loanId: loan.id, amount: first.totalDue, paymentMethod: "EFT", reference: `EFT-${id}` }, { "Idempotency-Key": `walk-payment-${t}` }))
    await ok(receipt)
    const paid = await db().repaymentSchedule.findFirstOrThrow({ where: { loanId: loan.id, installmentNo: 1 } })
    expect(paid.totalPaid).toBe(first.totalDue)

    // 6. Arrears letter: not while the account is up to date.
    expect((await arrearsLetter(post(`/api/loans/${loan.id}/arrears-letter`), on(loan.id))).status).toBe(422)
    // The second instalment falls due unpaid: five days on, at 10:00 SAST (dunning hours), the DPD job finds it.
    const overdueAt = new Date(second.dueDate.getTime() + 5 * 86_400_000)
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${sastCalendarDate(overdueAt)}T08:00:00Z`) })
    await ok(await dpdCron(new NextRequest("http://localhost/api/cron/dpd-update", { headers: { "x-cron-secret": CRON_SECRET } })))
    const overdue = await db().loan.findUniqueOrThrow({ where: { id: loan.id } })
    expect(overdue.daysInArrears).toBeGreaterThanOrEqual(1)
    expect(overdue.arrearsAmount).toBeGreaterThan(0)

    // Section 129 is not reachable: the route refuses by law, whichever way it is asked.
    const s129 = await section129(post("/api/loans/section129", { loanId: loan.id }))
    expect(s129.status).toBe(422)
    expect(await s129.json()).toMatchObject({ error: expect.stringMatching(/South African National Credit Act/) })

    holder.sendEmail.mockClear()
    const letter = await ok(await arrearsLetter(post(`/api/loans/${loan.id}/arrears-letter`), on(loan.id)), 201)
    expect(letter).toMatchObject({ sample: true, templateVersion: 1, delivery: [expect.objectContaining({ channel: "EMAIL", outcome: "sent" })] })
    const row = await db().loanArrearsLetter.findUniqueOrThrow({ where: { id: letter.letterId } })
    // The letter states what the loan says is overdue, on what is left to pay.
    expect(row).toMatchObject({ loanId: loan.id, arrearsAmount: overdue.arrearsAmount, daysInArrears: overdue.daysInArrears, sample: true, issuedById: stack.officer })
    expect(row.totalOutstanding).toBeGreaterThanOrEqual(row.arrearsAmount)
    expect(row.arrearsAmount).toBeGreaterThanOrEqual(second.totalDue)
    const printed = printedLast()
    expect(printed).toContain("Arrears letter")
    expect(printed).toContain("SAMPLE")
    expect(printed).toContain(loan.reference)
    expect(printed).toContain(formatZAR(row.arrearsAmount))
    expect(await db().clientDocument.findUniqueOrThrow({ where: { id: row.clientDocumentId } })).toMatchObject({ clientId, contentSha256: row.pdfSha256 })
    expect(holder.sendEmail).toHaveBeenCalledTimes(1)
    const sent = holder.sendEmail.mock.calls[0][0] as { to: string; attachments: { contentType: string; content: Buffer }[] }
    expect(sent.to).toBe(`${id}@test.invalid`)
    expect(sent.attachments[0]).toMatchObject({ contentType: "application/pdf" })
    expect(sent.attachments[0].content.toString()).toContain("Arrears letter")
    expect(await db().message.findFirst({ where: { tenantId: stack.tenant, dunning: true, channel: "EMAIL" } })).not.toBeNull()
    expect(await db().auditLog.count({ where: { tenantId: stack.tenant, entityId: loan.id, action: "ARREARS_LETTER_ISSUED" } })).toBe(1)
    expect(await db().loanNote.findFirst({ where: { loanId: loan.id, type: "arrears_letter" } })).toMatchObject({ documentId: row.clientDocumentId })
    expect(await db().complianceRecord.count({ where: { tenantId: stack.tenant, type: "SECTION_129_NOTICE" } })).toBe(0)
  })
})
