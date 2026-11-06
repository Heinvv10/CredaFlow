/**
 * A Kenyan loan end to end on real Postgres, with no session_replication_role shortcut (KE-5): the borrower applies in
 * the portal having read the indicative key facts statement; staff review, clear the credit-check findings (NO_STATEMENT)
 * with a reason, and approve, which issues the demo lender's own Kenyan templates (prisma/seed/kenya-templates.ts); the key
 * facts statement shows the CBK product approval reference, the excise inside the fees, the total cost of credit and KSh
 * figures; the borrower acknowledges, accepts and signs; a second person confirms the account and a second officer pays out
 * manually with an M-Pesa transaction code as the reference; a signed simulated Paybill (C2B) payment quoting the loan
 * reference goes through the real webhook and ingest and books against the loan; a Paybill payment quoting a wrong
 * reference waits UNMATCHED until staff allocate it, confirming the amount; the clock moves past an unpaid instalment, the
 * DPD job runs and collections issues the arrears letter. Section 129 stays out of reach.
 *
 * Mocked, as ls-walk.integration.test.ts does: the session, the tenant frame, the RLS-bound client (createAppPrismaClient is
 * real), the PDF renderer (the HTML is the "PDF", so what was printed can be read), file storage, the email transport and
 * the lender identity. Nothing under test (routes, ingest, review, gates, triggers) is mocked.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/non-nca-documents/ke-end-to-end.integration.test.ts
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
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Kenya end to end IT", domain: null, status: "ACTIVE" })),
  }
})
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => ({ failedLegs: [] })) }))
vi.mock("@/lib/email/service", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/email/service")>()), sendEmail: holder.sendEmail }))
vi.mock("@/lib/storage", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/storage")>()),
  saveFile: async (buffer: Buffer) => { const path = `/mem/${randomUUID()}.pdf`; holder.files.set(path, buffer); return { storagePath: path, fileSize: buffer.length } },
  readFile: async (path: string) => { const b = holder.files.get(path); if (!b) throw new Error("missing"); return b },
  deleteFile: async (path: string) => { holder.files.delete(path) },
}))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (html: string) => Buffer.from(`%PDF-synthetic ${html} ${randomUUID()}`) }))
vi.mock("@/lib/signing-otp/policy", async (original) => ({ ...(await original<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => false }))
vi.mock("@/lib/config/identity", async (importOriginal) => {
  const identity = { legalName: "Demo Nairobi Credit Ltd", tradingName: "Demo Nairobi Credit", ncrNumber: null, registeredOfficeLines: ["1 Demo Road, Nairobi, 00100"] }
  return { ...(await importOriginal<typeof import("@/lib/config/identity")>()), findLenderIdentity: async () => identity, getLenderIdentity: async () => identity }
})

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { activeJurisdiction, resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { exciseIncludedInFees, KENYA_RULES } from "@/lib/jurisdiction/kenya-rules"
import { provisionContactForClient } from "@/lib/contact/provision"
import { recomputeApplicationFlags } from "@/lib/credit-checks/recompute"
import { simulatedC2BPayment } from "@/lib/mobile-money/providers/simulated"
import { sastCalendarDate } from "@/lib/date/sast"
import { runWithTenant } from "@/lib/tenant-scope"
import { formatZAR } from "@/lib/utils"
import { POST as apply } from "@/app/api/portal/applications/route"
import { POST as quoteKeyFacts } from "@/app/api/portal/key-facts-quote/route"
import { POST as review } from "@/app/api/applications/[id]/review/route"
import { POST as clearFlag } from "@/app/api/applications/[id]/checks/[flagId]/clear/route"
import { POST as accept } from "@/app/api/applications/[id]/loan-documents/accept/route"
import { POST as acknowledge } from "@/app/api/applications/[id]/loan-documents/acknowledge/route"
import { GET as documents } from "@/app/api/applications/[id]/loan-documents/route"
import { POST as sign } from "@/app/api/applications/[id]/loan-documents/sign/route"
import { POST as mpesaWebhook } from "@/app/api/webhooks/mobile-money/[provider]/route"
import { POST as simulatePaybill } from "@/app/api/payments/mobile-money/simulate/route"
import { PATCH as reviewMobileMoney } from "@/app/api/payments/mobile-money/[id]/route"
import { GET as dpdCron } from "@/app/api/cron/dpd-update/route"
import { POST as arrearsLetter } from "@/app/api/loans/[id]/arrears-letter/route"
import { POST as section129 } from "@/app/api/loans/section129/route"
import { nonNcaTemplateSet } from "@/prisma/seed/non-nca-templates"
import { PRODUCTS_KE } from "@/prisma/seed/kenya-products"
import { createTemplate } from "./gate.integration-fixture"
import { ARREARS_LETTER_TEMPLATE_KEY, LOAN_DOCUMENT_TEMPLATE_KEYS } from "./keys"
import { lsFlow } from "./ls-flow.integration-fixture"
import { createRlsRole, seedBorrower, seedStack, stackOf } from "./ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("KE", t)
const role = `cf_kee2e_${t}`
const id = `kewalk-${t}`
const clientId = `${id}-client`
const CRON_SECRET = "synthetic-cron-secret-for-this-suite"
const MPESA_SECRET = "synthetic-mpesa-secret-for-this-suite"
const PERSONAL = PRODUCTS_KE.find((p) => p.code === "PERSONAL")!
const AMOUNT_KES = 20_000
const TERM_DAYS = 180
/** An M-Pesa receipt-number-shaped payout reference (10 characters): the manual payout's bank reference. */
const PAYOUT_CODE = `TK${t.slice(0, 8).toUpperCase()}`

let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const flow = lsFlow(db, stack, holder)
const literal = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
const printedLast = () => [...holder.files.values()].at(-1)!.toString()

const asClient = () => { holder.session = { user: { id: clientId, role: "CLIENT", email: `${id}@test.invalid`, tenantId: stack.tenant } } }
const asStaff = (userId: string, staffRole = "LOAN_ADMIN") => { holder.userId = userId; holder.role = staffRole; holder.session = { user: { id: userId, role: staffRole, email: `${userId}@test.invalid`, tenantId: stack.tenant } } }
const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(`http://localhost${url}`, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } }) })
const on = (resourceId: string) => ({ params: Promise.resolve({ id: resourceId }) })
const ok = async (res: Response, status = 200) => { const body = await res.clone().json(); expect(res.status, JSON.stringify(body)).toBe(status); return body }

suite("a Kenyan loan, apply to arrears letter with M-Pesa repayments (real Postgres, real routes, no bypass)", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "KE", currency: "KES" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "KEW", isDemoLender: true })
    await db().loanProduct.create({ data: { tenantId: stack.tenant, ...PERSONAL } })
    // The Kenyan demo lender's own four templates, exactly as DEMO_LENDER=nairobi seeds them.
    const { bodies } = nonNcaTemplateSet("KE")
    for (const kind of ["OFFER_LETTER", "KEY_FACTS_STATEMENT", "LOAN_AGREEMENT"] as const) await createTemplate(db(), stack.tenant, LOAN_DOCUMENT_TEMPLATE_KEYS[kind], bodies[kind])
    await createTemplate(db(), stack.tenant, ARREARS_LETTER_TEMPLATE_KEY, bodies.ARREARS_LETTER)
    await db().emailConfig.create({ data: { tenantId: stack.tenant, fromName: "Demo Nairobi Credit", fromAddress: "hello@nairobi-credit.example" } })
    const { statement } = await seedBorrower(db(), stack, id)
    holder.files.set(statement.path, statement.bytes)
    await db().$transaction((tx) => db().client.findUniqueOrThrow({ where: { id: clientId } }).then((c) => provisionContactForClient(tx as never, {
      tenantId: stack.tenant, clientId, firstName: c.firstName, lastName: c.lastName, email: c.email, phone: c.phone, whatsapp: c.whatsapp, source: "MANUAL",
    })))
    vi.stubEnv("TENANT_RLS", "on")
    vi.stubEnv("CRON_SECRET", CRON_SECRET)
    vi.stubEnv("SIMULATED_MPESA_WEBHOOK_SECRET", MPESA_SECRET)
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

  it("applies, approves, signs, pays out, repays by M-Pesa Paybill and gets an arrears letter, each step by the person whose step it is", async () => {
    expect(activeJurisdiction()).toBe("KE")

    // 1. Apply, having read the indicative key facts statement for these exact terms.
    asClient()
    const form = { productCode: PERSONAL.code, amount: AMOUNT_KES, termDays: TERM_DAYS, purpose: "School fees" }
    const unread = await apply(post("/api/portal/applications", form))
    expect(unread.status).toBe(422)
    expect(await unread.json()).toMatchObject({ keyFacts: "required" })
    const quote = await ok(await quoteKeyFacts(post("/api/portal/key-facts-quote", form)), 201)
    const indicative = printedLast()
    expect(indicative).toContain("INDICATIVE")
    expect(indicative).toContain("SAMPLE")
    expect(indicative).toContain("KSh 20,000.00")
    expect(indicative).toContain("CBK/DEMO/0001")
    const applied = await ok(await apply(post("/api/portal/applications", { ...form, keyFactsDocumentSha256: quote.sha256 })), 201)
    const applicationId: string = applied.applicationId ?? applied.id
    expect(await db().loanApplication.findUniqueOrThrow({ where: { id: applicationId } })).toMatchObject({ disclosureRegime: "KEY_FACTS", status: "SUBMITTED" })

    // 2. Review: the findings are raised (no recent statement) and a loan admin clears each with a written reason.
    asStaff(stack.officer)
    await ok(await review(post(`/api/applications/${applicationId}/review`, {}, { accept: "application/json" }), on(applicationId)))
    await runWithTenant(stack.tenant, () => recomputeApplicationFlags(stack.tenant, applicationId, { userId: stack.officer }))
    const open = await db().applicationCheckFlag.findMany({ where: { tenantId: stack.tenant, applicationId, status: "OPEN" } })
    expect(open.map((f) => f.code)).toContain("NO_STATEMENT")
    for (const flag of open) {
      const res = await clearFlag(post(`/api/applications/${applicationId}/checks/${flag.id}/clear`, { reason: "Synthetic: the borrower's current statement was seen at the branch." }),
        { params: Promise.resolve({ id: applicationId, flagId: flag.id }) })
      await ok(res)
    }

    // 3. Approve: the three documents issue with the approval, from the lender's Kenyan templates.
    await ok(await flow.decideForm(applicationId, { action: "approve", repaymentMethod: "EFT" }))
    expect(await db().loanDocumentIssuance.count({ where: { applicationId, supersededAt: null } })).toBe(3)
    const kfsIssuance = await db().loanDocumentIssuance.findFirstOrThrow({ where: { applicationId, kind: "KEY_FACTS_STATEMENT", supersededAt: null }, include: { clientDocument: true } })
    const kfs = holder.files.get(kfsIssuance.clientDocument.storagePath!)!.toString()
    expect(kfs).toContain("Key facts statement")
    expect(kfs).toContain("CBK product approval reference")
    expect(kfs).toContain("CBK/DEMO/0001")
    expect(kfs).toContain("Excise duty included in the fees")
    expect(kfs).toContain("Total cost of credit (interest and fees)")
    expect(kfs).toContain("KSh 20,000.00")
    expect(kfs).toContain("M-Pesa Paybill")
    expect(kfs).not.toMatch(/\bR \d/)

    // 4. Sign: the borrower acknowledges the KFS, accepts the offer and signs, on the digests they were shown.
    await flow.attestKyc(id)
    const state = await ok(await documents(new NextRequest("http://localhost/x"), on(applicationId)))
    const sha = (kind: string): string => state.documents.find((d: { kind: string }) => d.kind === kind).pdfSha256
    asClient()
    await ok(await acknowledge(post("/x", { documentSha256: sha("KEY_FACTS_STATEMENT") }), on(applicationId)))
    await ok(await accept(post("/x", { documentSha256: sha("OFFER_LETTER") }), on(applicationId)))
    await ok(await sign(post("/x", { agreementDocumentSha256: sha("LOAN_AGREEMENT"), signature: "Synthetic Borrower" }), on(applicationId)))

    // 5. Pay out: a second person confirms the account; a second officer records the manual payout, the M-Pesa code as its reference.
    expect((await flow.verifyAccount(stack.confirmer, applicationId)).status).toBe(200)
    expect(await ok(await flow.disburseAs(stack.disburser, applicationId, { bankRef: PAYOUT_CODE }))).toMatchObject({ payout: { channel: "MANUAL" } })
    const loan = await db().loan.findUniqueOrThrow({ where: { applicationId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
    expect(loan).toMatchObject({ status: "ACTIVE", principal: AMOUNT_KES * 100, creditLifePremiums: 0, totalPaid: 0 })
    expect(loan.repaymentSchedule.length).toBeGreaterThanOrEqual(3)
    expect((await db().loanApplication.findUniqueOrThrow({ where: { id: applicationId } })).disbursementRef).toBe(PAYOUT_CODE)
    // The figures the key facts statement printed are the booked loan's: the excise inside the initiation fee (no service fee
    // on this product) and the total cost of credit, interest plus fees.
    expect(PERSONAL.monthlyServiceFee).toBe(0)
    expect(loan.initiationFee).toBeGreaterThan(0)
    expect(kfs).toMatch(new RegExp(`Excise duty included in the fees[^]*?<td>${literal(formatZAR(exciseIncludedInFees(loan.initiationFee, KENYA_RULES.feeExciseRate)))}</td>`))
    expect(kfs).toMatch(new RegExp(`Total cost of credit \\(interest and fees\\)</td><td>${literal(formatZAR(loan.totalInterest + loan.initiationFee))}</td>`))

    // 6. Repay by Paybill: a signed simulated C2B confirmation quoting the loan reference, through the public webhook and the ingest.
    const [first, second] = loan.repaymentSchedule
    const transId = `SIM${t.slice(0, 7).toUpperCase()}`
    const paid = simulatedC2BPayment({ tenantId: stack.tenant, billRef: loan.reference.toLowerCase(), amountCents: first.totalDue, msisdn: "254712345678", transId })
    const hook = await mpesaWebhook(new NextRequest("http://localhost/api/webhooks/mobile-money/simulated", { method: "POST", body: paid.rawBody, headers: paid.headers }),
      { params: Promise.resolve({ provider: "simulated" }) })
    expect(await ok(hook)).toMatchObject({ ResultCode: 0, outcome: "BOOKED" })
    const afterPaybill = await db().loan.findUniqueOrThrow({ where: { id: loan.id } })
    expect(afterPaybill.totalPaid).toBe(first.totalDue)
    expect(afterPaybill.outstandingPrincipal).toBeLessThan(loan.outstandingPrincipal)
    expect((await db().repaymentSchedule.findFirstOrThrow({ where: { loanId: loan.id, installmentNo: 1 } })).totalPaid).toBe(first.totalDue)
    expect(await db().payment.findFirstOrThrow({ where: { loanId: loan.id, reference: transId } })).toMatchObject({ paymentMethod: "MOBILE_MONEY", amount: first.totalDue, idempotencyKey: `mpesa-c2b:${transId}` })
    expect(await db().mobileMoneyTransaction.findFirstOrThrow({ where: { tenantId: stack.tenant, transId } })).toMatchObject({ status: "BOOKED", loanId: loan.id, msisdnLast4: "5678", simulated: true })

    // 7. A Paybill payment quoting a wrong account number (the demo's "Simulate paybill payment") waits UNMATCHED, books nothing,
    //    until collections allocates it to the loan, confirming the amount.
    const SMALL_KES = 100
    vi.stubEnv("DEMO_MODE", "true")
    asStaff(stack.officer)
    expect(await ok(await simulatePaybill(post("/api/payments/mobile-money/simulate", { loanReference: `${loan.reference}-TYPO`, amount: SMALL_KES })))).toEqual({ outcome: "UNMATCHED" })
    vi.stubEnv("DEMO_MODE", "")
    const waiting = await db().mobileMoneyTransaction.findFirstOrThrow({ where: { tenantId: stack.tenant, status: "UNMATCHED" } })
    expect(waiting).toMatchObject({ loanId: null, paymentId: null, amount: SMALL_KES * 100 })
    expect((await db().loan.findUniqueOrThrow({ where: { id: loan.id } })).totalPaid).toBe(first.totalDue)
    const patch = (body: unknown) => reviewMobileMoney(new NextRequest(`http://localhost/api/payments/mobile-money/${waiting.id}`, { method: "PATCH", body: JSON.stringify(body), headers: { "content-type": "application/json" } }), on(waiting.id))
    expect((await patch({ action: "allocate", loanReference: loan.reference, confirmedAmount: SMALL_KES * 100 + 1 })).status).toBe(409)
    expect(await ok(await patch({ action: "allocate", loanReference: loan.reference, confirmedAmount: SMALL_KES * 100 }))).toMatchObject({ status: "BOOKED" })
    expect((await db().loan.findUniqueOrThrow({ where: { id: loan.id } })).totalPaid).toBe(first.totalDue + SMALL_KES * 100)
    expect(await db().mobileMoneyTransaction.findUniqueOrThrow({ where: { id: waiting.id } })).toMatchObject({ status: "BOOKED", loanId: loan.id, resolvedById: stack.officer })
    expect(await db().auditLog.count({ where: { tenantId: stack.tenant, entityId: waiting.id, action: "MOBILE_MONEY_ALLOCATED", userId: stack.officer } })).toBe(1)

    // 8. Arrears letter: the second instalment falls due short; five days on, at 10:00 SAST, the DPD job finds it.
    expect((await arrearsLetter(post(`/api/loans/${loan.id}/arrears-letter`), on(loan.id))).status).toBe(422)
    const overdueAt = new Date(second.dueDate.getTime() + 5 * 86_400_000)
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(`${sastCalendarDate(overdueAt)}T08:00:00Z`) })
    await ok(await dpdCron(new NextRequest("http://localhost/api/cron/dpd-update", { headers: { "x-cron-secret": CRON_SECRET } })))
    const overdue = await db().loan.findUniqueOrThrow({ where: { id: loan.id } })
    expect(overdue.daysInArrears).toBeGreaterThanOrEqual(1)
    expect(overdue.arrearsAmount).toBeGreaterThan(0)
    const s129 = await section129(post("/api/loans/section129", { loanId: loan.id }))
    expect(s129.status).toBe(422)
    expect(await s129.json()).toMatchObject({ error: expect.stringMatching(/South African National Credit Act/) })

    holder.sendEmail.mockClear()
    const letter = await ok(await arrearsLetter(post(`/api/loans/${loan.id}/arrears-letter`), on(loan.id)), 201)
    expect(letter).toMatchObject({ sample: true, templateVersion: 1, delivery: [expect.objectContaining({ channel: "EMAIL", outcome: "sent" })] })
    const row = await db().loanArrearsLetter.findUniqueOrThrow({ where: { id: letter.letterId } })
    expect(row).toMatchObject({ loanId: loan.id, arrearsAmount: overdue.arrearsAmount, daysInArrears: overdue.daysInArrears, sample: true, issuedById: stack.officer })
    const printed = printedLast()
    expect(printed).toContain("Arrears letter")
    expect(printed).toContain("SAMPLE")
    expect(printed).toContain(`Account number: ${loan.reference}`)
    expect(printed).toContain(formatZAR(row.arrearsAmount))
    expect(formatZAR(row.arrearsAmount)).toMatch(/^KSh /)
    expect(holder.sendEmail).toHaveBeenCalledTimes(1)
    expect(await db().auditLog.count({ where: { tenantId: stack.tenant, entityId: loan.id, action: "ARREARS_LETTER_ISSUED" } })).toBe(1)
    expect(await db().complianceRecord.count({ where: { tenantId: stack.tenant, type: "SECTION_129_NOTICE" } })).toBe(0)
  })
})
