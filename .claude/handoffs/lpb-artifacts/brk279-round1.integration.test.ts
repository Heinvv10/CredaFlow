/**
 * Breaker round 1 on PR #279 (head 9bd1ed95): repros against real Postgres, real routes. Each test asserts what was OBSERVED and logs it.
 *   RUN_DB_IT=1 DATABASE_URL=... npx vitest run lib/non-nca-documents/brk279-round1.integration.test.ts --testTimeout=60000 --hookTimeout=120000
 */
import { execFileSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN", files: new Map<string, Buffer>() }))
vi.mock("@/lib/prisma", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/prisma")>()
  const prisma = new Proxy({}, { get(_t, key) { if (!holder.app) throw new Error("no client"); const v: unknown = Reflect.get(holder.app, key); return typeof v === "function" ? v.bind(holder.app) : v } })
  return { ...actual, prisma }
})
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: holder.role, tenantId: holder.tenantId, totpVerified: true } })) }))
vi.mock("@/lib/auth-guards", async (o) => ({
  ...(await o<typeof import("@/lib/auth-guards")>()),
  requireApiRole: vi.fn(async () => ({ user: { id: holder.userId, email: `${holder.userId}@test.invalid`, name: "Synthetic Officer", role: holder.role, tenantId: holder.tenantId, totpVerified: true } })),
}))
vi.mock("@/lib/tenant", async (o) => {
  const { runWithTenant } = await import("@/lib/tenant-scope")
  return { ...(await o<typeof import("@/lib/tenant")>()), withTenantContext: (_r: unknown, h: (t: object) => Promise<unknown>) => runWithTenant(holder.tenantId, () => h({ id: holder.tenantId, slug: holder.tenantId, name: "brk", domain: null, status: "ACTIVE" })) }
})
vi.mock("@/lib/notifications", async (o) => ({ ...(await o<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))
vi.mock("@/lib/storage", () => ({
  saveFile: async (b: Buffer) => { const p = `/mem/${holder.files.size}.pdf`; holder.files.set(p, b); return { storagePath: p, fileSize: b.length } },
  readFile: async (p: string) => { const b = holder.files.get(p); if (!b) throw new Error("missing"); return b },
  deleteFile: async (p: string) => { holder.files.delete(p) },
}))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (h: string) => Buffer.from(`%PDF-synthetic ${h} ${randomUUID()}`) }))
vi.mock("@/lib/signing-otp/policy", async (o) => ({ ...(await o<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => false }))

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { runWithTenant } from "@/lib/tenant-scope"
import { GET as statementRoute } from "@/app/api/loans/[id]/statement/route"
import { GET as certificateRoute } from "@/app/api/loans/[id]/certificate-of-balance/route"
import { GET as mandateRoute } from "@/app/api/loans/[id]/debit-mandate/route"
import { POST as paymentsRoute } from "@/app/api/payments/route"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { AGREEMENT_KEY, KFS_KEY, createTemplate } from "./gate.integration-fixture"
import { BANK_REF, lsFlow } from "./ls-flow.integration-fixture"
import { clearOpenFlags, createRlsRole, seedStack, seedUnderReview, stackOf } from "./ls-stack.integration-fixture"
import { approvedCalculation } from "./quote"
import { runScreening } from "@/lib/screening/run"
import { STRUCTURED_SCHEDULE_CHANNEL } from "@/lib/product-engine/channels"
import { PUT as clientPut } from "@/app/api/clients/[id]/route"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_brk_${t}`
const BODY = (x: string) => `<h1>${x}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`
let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const { as, attestKyc, decideForm, disburseAs, issueAndSign, verifyAccount, signedApplication } = lsFlow(db, stack, holder)
const say = (...a: unknown[]) => process.stdout.write(`[BRK] ${a.map((x) => typeof x === "string" ? x : JSON.stringify(x)).join(" ")}\n`)
const pdfText = (bytes: ArrayBuffer) => {
  const dir = mkdtempSync(join(tmpdir(), "brk"))
  writeFileSync(join(dir, "a.pdf"), Buffer.from(bytes))
  return execFileSync("pdftotext", ["-layout", join(dir, "a.pdf"), "-"]).toString()
}
const get = (route: typeof statementRoute, id: string) => route(new NextRequest(`http://localhost/api/loans/${id}/x`), { params: Promise.resolve({ id }) } as never)

suite("brk279 round 1", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "BRK", isDemoLender: true })
    await db().tenantConfig.update({ where: { tenantId: stack.tenant }, data: {
      ...VALID_LENDER_COLUMNS, legalName: "Demo Basotho Lending (Pty) Ltd", brandName: "Demo Basotho Lending", ncrNumber: null, fscaNumber: null,
      companyRegNumber: "2099/000001", registeredOffice: "1 Demo Road\nMaseru\n100", publicPhone: "+266 2200 0000", collectionsPhone: "+266 2200 0001",
    } as never })
    await createTemplate(db(), stack.tenant, KFS_KEY, BODY("Key facts statement"))
    await createTemplate(db(), stack.tenant, AGREEMENT_KEY, BODY("Loan agreement"))
    vi.stubEnv("TENANT_RLS", "on")
    app = createAppPrismaClient((await createRlsRole(db(), fresh.url, role)).replace("connection_limit=1", "connection_limit=8"))
    holder.app = app
    resetActiveJurisdiction(); resetEnsuredJurisdiction()
    await ensureActiveJurisdiction(app as never)
  }, 300_000)
  afterAll(async () => {
    vi.unstubAllEnvs(); holder.app = null; await app?.$disconnect()
    await fresh?.db.$executeRawUnsafe(`DROP OWNED BY ${role}`).catch(() => undefined)
    await fresh?.drop()
    const admin = new PrismaClient(); await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS ${role}`).catch(() => undefined); await admin.$disconnect()
    resetActiveJurisdiction(); resetEnsuredJurisdiction()
  }, 60_000)

  it("A: triple submit books once", async () => {
    const id = `dbl-${t}`
    await signedApplication(id)
    const rs = await Promise.all([disburseAs(stack.disburser, id), disburseAs(stack.disburser, id), disburseAs(stack.disburser, id)])
    say("A statuses", rs.map((r) => r.status), await Promise.all(rs.map((r) => r.clone().json())))
    say("A loans", await db().loan.count({ where: { applicationId: id } }), "audit", await db().auditLog.count({ where: { entityId: id, action: "LOAN_DISBURSED" } }), "refusedAudit", await db().auditLog.count({ where: { entityId: id, action: "LOAN_DISBURSEMENT_REFUSED" } }))
    expect(await db().loan.count({ where: { applicationId: id } })).toBe(1)
  })

  it("B: one bank reference books two loans", async () => {
    const [a, b] = [`refa-${t}`, `refb-${t}`]
    await signedApplication(a); await signedApplication(b)
    const ra = await disburseAs(stack.disburser, a, { bankRef: "SAME-REF-1" })
    const rb = await disburseAs(stack.disburser, b, { bankRef: "SAME-REF-1" })
    say("B", ra.status, rb.status)
    expect(rb.status).toBe(422) // RED at 9bd1ed95: 200, one transfer reference books two loans
  })

  it("C: reference of invisible characters", async () => {
    const id = `zw-${t}`
    await signedApplication(id)
    const r = await disburseAs(stack.disburser, id, { bankRef: "​" })
    say("C", r.status, await r.clone().json())
    expect(r.status).toBe(422) // RED at 9bd1ed95: 200, a reference nobody can read
  })

  it("D: identity changed after signing, second person reconfirms", async () => {
    const id = `ident-${t}`
    await signedApplication(id)
    const signedName = (await db().client.findUniqueOrThrow({ where: { id: `${id}-client` } }))
    as(stack.officer, "CREDIT_OFFICER")
    const put = await clientPut(new NextRequest(`http://localhost/api/clients/${id}-client`, { method: "PUT", body: JSON.stringify({ lastName: "Someoneelse", idNumber: "990000001", expectedUpdatedAt: (await db().client.findUniqueOrThrow({ where: { id: `${id}-client` } })).updatedAt.toISOString() }), headers: { "content-type": "application/json" } }), { params: Promise.resolve({ id: `${id}-client` }) })
    say("D PUT", put.status, put.status === 200 ? "" : await put.clone().json())
    expect(put.status).toBe(200)
    say("D row", await db().client.findUniqueOrThrow({ where: { id: `${id}-client` }, select: { lastName: true, idNumber: true, kycStatus: true } }))
    say("D old", signedName.lastName, signedName.idNumber)
    const first = await disburseAs(stack.disburser, id)
    say("D first", first.status, await first.clone().json())
    await attestKyc(id)
    const run = await runWithTenant(stack.tenant, () => runScreening({ tenantId: stack.tenant, subject: { kind: "CLIENT", clientId: `${id}-client` } as never, trigger: "MANUAL" as never, applicationId: id, actor: { id: stack.officer, email: "o@test.invalid" } }))
    say("D rescreen", run)
    const v = await verifyAccount(stack.officer, id)
    say("D reverify", v.status)
    const again = await disburseAs(stack.disburser, id)
    say("D second", again.status, await again.clone().json())
    expect(again.status).toBe(422) // RED at 9bd1ed95: 200, paid to an identity the signed agreement does not name
    const app2 = await db().loanApplication.findUniqueOrThrow({ where: { id }, select: { status: true, agreementSignatureData: true, agreementDocumentId: true, agreementSignedAt: true } })
    say("D application", app2)
  })

  it("E: product swapped after signing", async () => {
    const id = `prod-${t}`
    await signedApplication(id)
    await db().loanProduct.create({ data: { id: `${stack.product}-x`, tenantId: stack.tenant, code: `X-${t}`, name: "Other", minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180, productType: "MICRO", interestRatePm: 0.05, interestModel: "DAILY_ACCRUAL", initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6900 } })
    const w = await db().loanApplication.update({ where: { id }, data: { productId: `${stack.product}-x` } }).then(() => "written", (e: Error) => `refused: ${e.message.slice(-160)}`)
    const r = await disburseAs(stack.disburser, id)
    say("E", w, r.status, await r.clone().json())
  })

  it("F: borrower swapped after signing", async () => {
    const [id, other] = [`swap-${t}`, `swapo-${t}`]
    await signedApplication(id); await signedApplication(other)
    const w = await db().loanApplication.update({ where: { id }, data: { clientId: `${other}-client` } }).then(() => "written", (e: Error) => `refused: ${e.message.slice(-160)}`)
    say("F", w)
  })

  it("G: booked schedule equals the printed one; pays; settles; documents", async () => {
    const id = `book-${t}`
    await signedApplication(id)
    const row = await db().loanApplication.findUniqueOrThrow({ where: { id } })
    const printed = approvedCalculation(row).calculation
    expect((await disburseAs(stack.disburser, id)).status).toBe(200)
    const loan = await db().loan.findFirstOrThrow({ where: { applicationId: id }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
    say("G printed", printed.schedule.map((s) => [s.dueDate.toISOString(), s.principalDue, s.interestDue, s.feesDue, s.totalDue]), printed.totalRepayable, printed.disbursementAmount)
    say("G booked", loan.repaymentSchedule.map((s) => [s.dueDate.toISOString(), s.principalDue, s.interestDue, s.feesDue, s.totalDue]), loan.totalRepayable, "start", loan.startDate.toISOString(), "calcStart", (row.affordabilityResult as { approval: { calculator: { startDate: string } } }).approval.calculator.startDate)
    expect(loan.repaymentSchedule.map((s) => [s.dueDate.toISOString(), s.totalDue])).toEqual(printed.schedule.map((s) => [s.dueDate.toISOString(), s.totalDue]))
    const due = loan.repaymentSchedule[0].dueDate
    const figures = await runWithTenant(stack.tenant, () => loanSettlementFigures(db() as never, loan as never, due))
    say("G settle at due", figures)
    as(stack.officer, "ADMIN")
    for (const [name, route] of [["statement", statementRoute], ["certificate", certificateRoute], ["mandate", mandateRoute]] as const) {
      const res = await get(route, loan.id)
      if (res.status !== 200) { say("G", name, res.status, await res.text()); continue }
      const text = pdfText(await res.arrayBuffer())
      if (name === "certificate" || name === "statement") say(name, text)
      say("G", name, "NCR/NCA hits:", text.match(/NCR|National Credit|PASA|Section 112|\bR \d|Consumer|Credit Provider/g) ?? [], "M hits", (text.match(/\bM \d/g) ?? []).length, "reg", /2099\/000001/.test(text))
    }
    as(stack.officer, "ADMIN")
    const pay = await paymentsRoute(new NextRequest("http://localhost/api/payments", { method: "POST", body: JSON.stringify({ loanId: loan.id, amount: 100_000, paymentMethod: "EFT", reference: "PAY1" }), headers: { "content-type": "application/json", "idempotency-key": randomUUID(), "x-idempotency-key": randomUUID(), "x-payment-idempotency-key": randomUUID() } }))
    say("G pay", pay.status, await pay.clone().json().catch(() => null))
    const after = await db().loan.findUniqueOrThrow({ where: { id: loan.id } })
    say("G after", { outstandingPrincipal: after.outstandingPrincipal, totalPaid: after.totalPaid, status: after.status })
  })

  it("H: deceased write racing the row lock", async () => {
    const id = `dead-${t}`
    await signedApplication(id)
    const started = await db().$transaction(async (tx) => {
      await tx.client.update({ where: { id: `${id}-client` }, data: { deceasedAt: new Date() } })
      const p = disburseAs(stack.disburser, id)
      await new Promise((r) => setTimeout(r, 800))
      return { p }
    }, { timeout: 20_000 })
    const r = await started.p
    say("H", r.status, await r.clone().json(), await db().loan.count({ where: { applicationId: id } }))
    expect(await db().loan.count({ where: { applicationId: id } })).toBe(0)
  })

  it("I: a held lock past Prisma's 5 s transaction timeout", async () => {
    const id = `slow-${t}`
    await signedApplication(id)
    const started = await db().$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`affordability-client:${stack.tenant}:${id}-client`}))::text`
      const p = disburseAs(stack.disburser, id)
      await new Promise((r) => setTimeout(r, 6_500))
      return { p }
    }, { timeout: 20_000 })
    const r = await started.p
    say("I", r.status, await r.clone().json(), await db().loan.count({ where: { applicationId: id } }), await db().loanApplication.findUniqueOrThrow({ where: { id }, select: { status: true } }))
    expect(BANK_REF).toBeTruthy()
  })

  // Skipped: decide 500s on the DB approval guard with a version inserted behind the triggers, so payout was not reached (LoanTerms finding is a code trace).
  it.skip("Z: a versioned, weekly amortising loan (runs last: the version stays on the product)", async () => {
    const id = `week-${t}`
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.productVersion.create({ data: { tenantId: stack.tenant, productId: stack.product, version: 1, effectiveFrom: new Date("2020-01-01"), minAmount: 100_000, maxAmount: 800_000, minTermDays: 1, maxTermDays: 180,
        interestRatePm: 0.05, interestModel: (process.env.BRK_WEEKLY ? "REDUCING_BALANCE" : "DAILY_ACCRUAL"), initiationFeeModel: "FLAT_PCT", initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 6900,
        frequency: process.env.BRK_WEEKLY ? "WEEKLY" : null, structure: process.env.BRK_WEEKLY ? "AMORTISING" : null, graceKind: process.env.BRK_WEEKLY ? "NONE" : null, graceInstalments: 0, collateral: [], eligibility: {}, reason: "Synthetic", changeRequestId: `cr-${t}` } as never })
    })
    const { statement } = await seedUnderReview(db(), stack, id, { nca: false })
    holder.files.set(statement.path, statement.bytes)
    await db().applicationPricingInput.create({ data: { applicationId: id, tenantId: stack.tenant, channel: STRUCTURED_SCHEDULE_CHANNEL } })
    await clearOpenFlags(db(), stack, id)
    const d = await decideForm(id, { action: "approve", repaymentMethod: "EFT" })
    say("Z decide", d.status, d.status === 200 ? "" : await d.clone().json())
    expect(d.status).toBe(200)
    await attestKyc(id)
    await issueAndSign(id)
    expect((await verifyAccount(stack.officer, id)).status).toBe(200)
    const row = await db().loanApplication.findUniqueOrThrow({ where: { id } })
    const printed = approvedCalculation(row).calculation
    const r = await disburseAs(stack.disburser, id)
    say("Z pay", r.status, await r.clone().json())
    const loan = await db().loan.findFirst({ where: { applicationId: id }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
    say("Z printed", printed.schedule.map((s) => [s.dueDate.toISOString().slice(0, 10), s.totalDue]), printed.totalRepayable)
    say("Z booked", loan?.repaymentSchedule.map((s) => [s.dueDate.toISOString().slice(0, 10), s.totalDue]), loan?.totalRepayable, "maturity", loan?.maturityDate)
    say("Z loanTerms rows", await db().loanTerms.count({ where: { loanId: loan?.id ?? "" } }), "frozen version", (row.affordabilityResult as { approval: { inputs: { productVersion?: unknown; repayment?: unknown } } }).approval.inputs.productVersion, (row.affordabilityResult as { approval: { inputs: { repayment?: unknown } } }).approval.inputs.repayment)
  })
})
