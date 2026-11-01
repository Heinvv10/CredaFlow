/**
 * What a key-facts payout writes, on real Postgres through the real routes with no session_replication_role: every booked figure against
 * the frozen approval, the version terms, the unique bank reference, the frozen identity, and the dry run the page runs before any transfer.
 * Mocked as ls-end-to-end.integration.test.ts mocks.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/non-nca-documents/ls-booking.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

const holder = vi.hoisted(() => ({ app: null as object | null, tenantId: "", userId: "", role: "LOAN_ADMIN", files: new Map<string, Buffer>() }))
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
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))
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
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Lesotho booking IT", domain: null, status: "ACTIVE" })),
  }
})
vi.mock("@/lib/notifications", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/notifications")>()), triggerNotification: vi.fn(async () => undefined) }))
vi.mock("@/lib/storage", () => ({
  saveFile: async (buffer: Buffer) => { const path = `/mem/${holder.files.size}.pdf`; holder.files.set(path, buffer); return { storagePath: path, fileSize: buffer.length } },
  readFile: async (path: string) => { const b = holder.files.get(path); if (!b) throw new Error("missing"); return b },
  deleteFile: async (path: string) => { holder.files.delete(path) },
}))
vi.mock("@/lib/documents/html-to-pdf", () => ({ htmlToPdf: async (html: string) => Buffer.from(`%PDF-synthetic ${html} ${randomUUID()}`) }))
vi.mock("@/lib/signing-otp/policy", async (original) => ({ ...(await original<typeof import("@/lib/signing-otp/policy")>()), isSigningOtpRequired: async () => false }))
vi.mock("@/lib/config/identity", () => ({ findLenderIdentity: async () => ({ legalName: "Demo Basotho Lending (Pty) Ltd", ncrNumber: null, registeredOfficeLines: ["1 Demo Road"] }) }))

import { NextRequest } from "next/server"
import { createAppPrismaClient } from "@/lib/prisma"
import { lockAffordabilityClientEvidence } from "@/lib/affordability/evidence-locks"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { triggerNotification } from "@/lib/notifications"
import { runScreening } from "@/lib/screening/run"
import { runWithTenant } from "@/lib/tenant-scope"
import { GET as payoutCheck } from "@/app/api/applications/[id]/payout-check/route"
import { PUT as clientPut } from "@/app/api/clients/[id]/route"
import { AGREEMENT_KEY, KFS_KEY, createTemplate } from "./gate.integration-fixture"
import { acknowledgeKeyFacts } from "./acknowledge"
import { BORROWER_REFUSAL } from "./borrower-gate"
import { issueLoanDocuments } from "./issue"
import { lsFlow } from "./ls-flow.integration-fixture"
import { createRlsRole, PRODUCT, seedStack, stackOf } from "./ls-stack.integration-fixture"
import { signKeyFactsAgreement } from "./sign"
import { loanDocumentState } from "./state"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_lsbook_${t}`
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`

let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db
const { approvedApplication, as, attestKyc, disburseAs, signedApplication, verifyAccount } = lsFlow(db, stack, holder)
const loans = (id: string) => db().loan.count({ where: { applicationId: id } })
const check = (id: string) => payoutCheck(new NextRequest(`http://localhost/api/applications/${id}/payout-check`), { params: Promise.resolve({ id }) })

interface FrozenCalculator { startDate: string; principalCents: number; totalInterestCents: number; totalRepayableCents: number; schedule: { installmentNo: number; dueDate: string; principalDueCents: number; interestDueCents: number; feesDueCents: number; totalDueCents: number }[] }
const frozenOf = (row: { affordabilityResult: unknown }) => (row.affordabilityResult as { approval: { calculator: FrozenCalculator; inputs: { interestRatePm: number; monthlyServiceFeeCents: number } } }).approval

suite("what a key-facts payout books, and when the officer may make the transfer (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "BOOK", isDemoLender: true })
    await createTemplate(db(), stack.tenant, KFS_KEY, BODY("Key facts statement"))
    await createTemplate(db(), stack.tenant, AGREEMENT_KEY, BODY("Loan agreement"))
    vi.stubEnv("TENANT_RLS", "on")
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

  it("books every figure of the frozen approval: the loan, its schedule, the agreement, the commission and the notification", async () => {
    const id = `figures-${t}`
    const before = Date.now()
    await signedApplication(id)
    const agent = await db().referralAgent.create({ data: { tenantId: stack.tenant, displayName: "Synthetic Agent", commissionBps: 250 } })
    const code = await db().referralCode.create({ data: { tenantId: stack.tenant, agentId: agent.id, code: `C${t}` } })
    await db().client.update({ where: { id: `${id}-client` }, data: { referralCodeId: code.id } })
    vi.mocked(triggerNotification).mockClear()

    expect((await disburseAs(stack.disburser, id)).status).toBe(200)

    const application = await db().loanApplication.findUniqueOrThrow({ where: { id }, include: { loan: { include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } } } })
    const { calculator, inputs } = frozenOf(application)
    const loan = application.loan!
    expect(loan).toMatchObject({
      principal: calculator.principalCents, totalInterest: calculator.totalInterestCents, totalRepayable: calculator.totalRepayableCents,
      contractualTotalInterest: calculator.totalInterestCents, contractualTotalRepayable: calculator.totalRepayableCents,
      outstandingPrincipal: calculator.principalCents, interestRatePm: inputs.interestRatePm, monthlyServiceFee: inputs.monthlyServiceFeeCents,
      interestModel: PRODUCT.interestModel, agreementDocId: application.agreementDocumentId, creditLifePremiums: 0,
    })
    expect(loan.interestRatePm).toBeGreaterThan(0)
    expect(loan.monthlyServiceFee).toBeGreaterThan(0)
    expect(loan.startDate.getTime()).toBe(application.disbursedAt!.getTime())
    expect(loan.startDate.getTime()).toBeGreaterThanOrEqual(before)
    expect(loan.startDate.getTime()).toBeLessThanOrEqual(Date.now())
    expect(loan.maturityDate.toISOString()).toBe(calculator.schedule.at(-1)!.dueDate)
    expect(loan.nextPaymentDate?.toISOString()).toBe(calculator.schedule[0].dueDate)
    expect(loan.repaymentSchedule.map((r) => ({ n: r.installmentNo, due: r.dueDate.toISOString(), principal: r.principalDue, interest: r.interestDue, fees: r.feesDue, total: r.totalDue }))).toEqual(
      calculator.schedule.map((s) => ({ n: s.installmentNo, due: s.dueDate, principal: s.principalDueCents, interest: s.interestDueCents, fees: s.feesDueCents, total: s.totalDueCents })),
    )
    expect(loan.repaymentSchedule[0].feesDue).toBeGreaterThan(0)
    expect(await db().loanTerms.count({ where: { loanId: loan.id } })).toBe(0)
    const commission = await db().referralEvent.findFirstOrThrow({ where: { tenantId: stack.tenant, eventType: "CONVERTED", metadata: { path: ["loanId"], equals: loan.id } } })
    expect(commission).toMatchObject({ commissionCents: Math.round(calculator.principalCents * 0.025), amountCents: calculator.principalCents })
    expect(triggerNotification).toHaveBeenCalledWith(expect.objectContaining({ tenantId: stack.tenant, event: "loan_disbursed", loanId: loan.id }))
  })

  it("the identity is bound: a name and ID number changed after signing are refused, even re-attested, re-screened and re-confirmed", async () => {
    const id = `ident-${t}`
    await signedApplication(id)
    as(stack.officer, "CREDIT_OFFICER")
    const clientId = `${id}-client`
    const put = await clientPut(new NextRequest(`http://localhost/api/clients/${clientId}`, {
      method: "PUT", headers: { "content-type": "application/json" },
      body: JSON.stringify({ lastName: "Someoneelse", idNumber: "990000001", expectedUpdatedAt: (await db().client.findUniqueOrThrow({ where: { id: clientId } })).updatedAt.toISOString() }),
    }), { params: Promise.resolve({ id: clientId }) })
    expect(put.status).toBe(200)
    await attestKyc(id)
    await runWithTenant(stack.tenant, () => runScreening({ tenantId: stack.tenant, subject: { kind: "CLIENT", clientId } as never, trigger: "MANUAL" as never, applicationId: id, actor: { id: stack.officer, email: `${stack.officer}@test.invalid` } } as never))
    expect((await verifyAccount(stack.senior, id)).status).toBe(200)
    const res = await disburseAs(stack.disburser, id)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "unchanged_affordability", affordabilitySnapshot: "changed" })
    expect(await loans(id)).toBe(0)
  })

  it("a changed identity also stops the documents being issued, acknowledged or signed", async () => {
    const id = `issue-${t}`
    await approvedApplication(id, { kyc: false })
    const staff = { id: stack.officer, email: `${stack.officer}@test.invalid` }
    const inTenant = <T,>(fn: () => Promise<T>) => runWithTenant(stack.tenant, fn)
    expect(await inTenant(() => issueLoanDocuments({ tenantId: stack.tenant, applicationId: id, staff }))).toMatchObject({ ok: true })
    const docs = (await inTenant(() => loanDocumentState(stack.tenant, id)))!.keyFacts!.documents
    const borrower = { tenantId: stack.tenant, applicationId: id, clientId: `${id}-client`, clientEmail: `${id}@test.invalid` }
    await db().client.update({ where: { id: `${id}-client` }, data: { firstName: "Someoneelse" } })
    expect(await inTenant(() => issueLoanDocuments({ tenantId: stack.tenant, applicationId: id, staff }))).toMatchObject({ ok: false, status: 409, error: expect.stringMatching(/identity changed/) })
    expect(await inTenant(() => acknowledgeKeyFacts({ ...borrower, shown: docs.find((d) => d.kind === "KEY_FACTS_STATEMENT")!.pdfSha256 }))).toMatchObject({ ok: false, status: 409, error: BORROWER_REFUSAL })
    expect(await inTenant(() => signKeyFactsAgreement({
      ...borrower, agreementDocumentSha256: docs.find((d) => d.kind === "LOAN_AGREEMENT")!.pdfSha256, signature: "Synthetic Borrower", signingOtpChallengeId: null, ipAddress: "203.0.113.9",
    }))).toMatchObject({ ok: false, status: 409, error: BORROWER_REFUSAL })
  })

  it("one transfer pays one loan: a reference used before, in any case, is a clean 409 and the second application stays approved", async () => {
    const first = `ref1-${t}`
    const second = `ref2-${t}`
    await signedApplication(first)
    await signedApplication(second)
    expect((await disburseAs(stack.disburser, first, { bankRef: `DUP-${t}` })).status).toBe(200)
    const res = await disburseAs(stack.disburser, second, { bankRef: `dup-${t}` })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "bank_reference_used" })
    expect(await loans(second)).toBe(0)
    expect((await disburseAs(stack.disburser, second, { bankRef: `DUP2-${t}` })).status).toBe(200)
  })

  it("spaces and width do not make it another transfer; punctuation does", async () => {
    const [first, second, third] = [`form1-${t}`, `form2-${t}`, `form3-${t}`]
    for (const id of [first, second, third]) await signedApplication(id)
    expect((await disburseAs(stack.disburser, first, { bankRef: `TX-${t}  A` })).status).toBe(200)
    expect(await db().loanApplication.findUniqueOrThrow({ where: { id: first } })).toMatchObject({ disbursementRef: `TX-${t}A` })
    for (const bankRef of [`TX-${t} A`, `tx-${t}\u00a0a`, `TX-${t}\uff21`]) {
      const res = await disburseAs(stack.disburser, second, { bankRef })
      expect(res.status, bankRef).toBe(409)
      expect(await res.json()).toMatchObject({ disbursementPrecondition: "bank_reference_used" })
    }
    expect((await disburseAs(stack.disburser, third, { bankRef: `TX.${t}A` })).status).toBe(200)
  })

  it("the dry run runs every gate and books nothing: refused until the second person confirmed, then ready, with the application untouched", async () => {
    const id = `dry-${t}`
    await signedApplication(id, { verified: false })
    as(stack.disburser)
    const refused = await (await check(id)).json()
    expect(refused).toMatchObject({ ok: false, disbursementPrecondition: "payout_account_verification" })
    expect((await verifyAccount(stack.senior, id)).status).toBe(200)
    as(stack.disburser)
    const before = await db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect(await (await check(id)).json()).toEqual({ ok: true })
    const after = await db().loanApplication.findUniqueOrThrow({ where: { id } })
    expect(after).toEqual(before)
    expect(await loans(id)).toBe(0)
    as(stack.officer)
    expect(await (await check(id)).json()).toMatchObject({ ok: false, disbursementPrecondition: "segregation_of_duties" })
    expect((await disburseAs(stack.disburser, id)).status).toBe(200)
    as(stack.disburser)
    expect(await (await check(id)).json()).toMatchObject({ ok: false, disbursementPrecondition: "status" })
  })

  it("dealer-typed contact details that nobody verified get their own refusal", async () => {
    const id = `dealer-${t}`
    const dealer = await db().dealer.create({ data: { tenantId: stack.tenant, name: "Synthetic Dealer", kind: "DEALER", contactEmail: `${id}@dealer.invalid`, createdById: stack.senior } })
    await signedApplication(id, { dealerId: dealer.id })
    const res = await disburseAs(stack.disburser, id)
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "dealer_contact_unverified" })
  })

  it("a lock held past the transaction's timeout is a 409, not a database refusal, and books nothing", async () => {
    const id = `slow-${t}`
    await signedApplication(id)
    // Prisma's timeout does not cancel a query blocked on a lock: it lands when the query returns. So hold until the payout is seen
    // waiting (however long its work before the transaction took), then past its 5 s, then let it go.
    const { started } = await db().$transaction(async (tx) => {
      await lockAffordabilityClientEvidence(tx, { tenantId: stack.tenant, clientId: `${id}-client` })
      const payout = disburseAs(stack.disburser, id)
      await vi.waitFor(async () => {
        const [{ waiting }] = await tx.$queryRaw<{ waiting: number }[]>`SELECT count(*)::int AS waiting FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`
        expect(waiting).toBeGreaterThan(0)
      }, { timeout: 30_000, interval: 100 })
      await new Promise((resolve) => setTimeout(resolve, 5_500))
      return { started: payout }
    }, { timeout: 45_000 })
    const res = await started
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "changed" })
    expect(await loans(id)).toBe(0)
  })
})
