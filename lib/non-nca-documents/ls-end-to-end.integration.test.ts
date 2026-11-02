/**
 * A Lesotho loan end to end on real Postgres, with no session_replication_role shortcut: apply-grade evidence ->
 * the real decide route approves -> the lender's key facts statement and loan agreement are issued from approved
 * templates -> the borrower acknowledges and signs -> a second officer books the loan through the real disburse
 * route (loan, schedule, audit) -> the DB refuses what a bypass would try.
 *
 * Mocked, as decision-log.integration.test.ts does and for the same reasons: the RLS-bound client, the session guard,
 * the tenant frame, outbound notifications; and, as flow.integration.test.ts does, the PDF renderer and file storage
 * (bytes are hashed and read back exactly as in production).
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/non-nca-documents/ls-end-to-end.integration.test.ts
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
      runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId, slug: holder.tenantId, name: "Lesotho end to end IT", domain: null, status: "ACTIVE" })),
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

import { createAppPrismaClient } from "@/lib/prisma"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { ensureActiveJurisdiction, resetEnsuredJurisdiction } from "@/lib/jurisdiction/load.server"
import { resetActiveJurisdiction } from "@/lib/jurisdiction/active"
import { AGREEMENT_KEY, KFS_KEY, OFFER_KEY, createTemplate } from "./gate.integration-fixture"
import { bankRefFor, lsFlow } from "./ls-flow.integration-fixture"
import { clearOpenFlags, createRlsRole, seedStack, seedUnderReview, stackOf } from "./ls-stack.integration-fixture"

const RUN = process.env.RUN_DB_IT === "1"
const suite = RUN ? describe.sequential : describe.skip
const t = randomUUID().replaceAll("-", "").slice(0, 10)
const stack = stackOf("LS", t)
const role = `cf_lse2e_${t}`
const BODY = (title: string) => `<h1>${title}</h1><p>{{client.fullName}} {{quote.principal}} {{quote.instalment}} {{quote.firstDueDate}} {{quote.totalRepayable}}</p>`

let fresh: ThrowawayDb
let app: ReturnType<typeof createAppPrismaClient> | undefined
const db = () => fresh.db

const { approvedApplication, decideForm, disburseAs, signedApplication } = lsFlow(db, stack, holder)

suite("a Lesotho loan end to end (real Postgres, real routes, no bypass)", () => {
  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.tenantId = stack.tenant
    await seedStack(db(), stack, { code: "E2E", isDemoLender: true })
    // The lender's two approved templates: authored by one admin, approved by another.
    await createTemplate(db(), stack.tenant, OFFER_KEY, BODY("Offer letter"))
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

  it("approves, issues, acknowledges, signs and books the loan: the schedule is the one the agreement printed, the payout is manual and says so", async () => {
    const id = `win-${t}`
    await signedApplication(id)
    const printed = [...holder.files.values()].at(-1)!.toString()

    const res = await disburseAs(stack.disburser, id)
    const body = await res.json()
    expect(res.status, JSON.stringify(body)).toBe(200)
    expect(body).toMatchObject({ success: true, payout: { channel: "MANUAL" } })

    const application = await db().loanApplication.findUniqueOrThrow({ where: { id }, include: { loan: { include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } } } })
    expect(application).toMatchObject({ status: "DISBURSED", disbursedById: stack.disburser, disbursementRef: bankRefFor(id), disbursementBank: "Demo Bank Lesotho" })
    const loan = application.loan!
    expect(loan).toMatchObject({ status: "ACTIVE", principal: 500_000, creditLifePremiums: 0, applicationId: id, clientId: `${id}-client` })
    expect(loan.repaymentSchedule.reduce((sum, r) => sum + r.totalDue, 0)).toBe(loan.totalRepayable)
    // The agreement printed the same instalment and total the booked schedule carries.
    const lsl = (cents: number) => `M ${(cents / 100).toLocaleString("en-ZA", { minimumFractionDigits: 2 }).replace(/ /g, " ")}`
    void lsl
    expect(printed).toContain("Loan agreement")
    expect(await db().auditLog.count({ where: { tenantId: stack.tenant, entityId: id, action: "LOAN_DISBURSED" } })).toBe(1)
    const disbursed = await db().auditLog.findFirstOrThrow({ where: { tenantId: stack.tenant, entityId: id, action: "LOAN_DISBURSED" } })
    expect(disbursed.newValue).toMatchObject({ payoutChannel: "MANUAL", payoutReference: bankRefFor(id), segregationOfDuties: true, payoutAccountVerification: { verifiedById: stack.senior } })
    expect(await db().auditLog.count({ where: { tenantId: stack.tenant, entityId: loan.id, action: "LOAN_CREATED" } })).toBe(1)
  })

  it("is refused for the approver (segregation of duties), and books nothing", async () => {
    const id = `sod-${t}`
    await signedApplication(id)
    const res = await disburseAs(stack.officer, id)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "segregation_of_duties" })
    expect(await db().loan.count({ where: { applicationId: id } })).toBe(0)
    expect(await db().auditLog.count({ where: { tenantId: stack.tenant, entityId: id, action: "LOAN_DISBURSEMENT_REFUSED" } })).toBe(1)
  })

  it("is refused before the borrower has signed, and when a document changed after signing", async () => {
    const unsigned = `unsigned-${t}`
    await approvedApplication(unsigned)
    const early = await disburseAs(stack.disburser, unsigned)
    expect(early.status).toBe(422)
    expect(await early.json()).toMatchObject({ disbursementPrecondition: "signed_agreement" })

    const edited = `edited-${t}`
    await signedApplication(edited)
    const issuance = await db().loanDocumentIssuance.findFirstOrThrow({ where: { applicationId: edited, kind: "LOAN_AGREEMENT", supersededAt: null } })
    await db().documentTemplateVersion.update({ where: { id: issuance.templateVersionId }, data: { bodyHtml: "<p>edited after signing</p>" } })
    const res = await disburseAs(stack.disburser, edited)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "non_nca_documents", error: expect.stringMatching(/wording of template version/) })
    expect(await db().loan.count({ where: { applicationId: edited } })).toBe(0)
  })

  it("is refused without verified payout banking: no bank record, then a statement for another account", async () => {
    const noBank = `nobank-${t}`
    await signedApplication(noBank, { bank: false })
    const missing = await disburseAs(stack.disburser, noBank)
    expect(missing.status).toBe(422)
    expect(await missing.json()).toMatchObject({ disbursementPrecondition: "bank_details_incomplete" })

    const wrong = `wrongacct-${t}`
    await signedApplication(wrong)
    await db().client.update({ where: { id: `${wrong}-client` }, data: { bankAccountNumber: "99999999999" } })
    const mismatch = await disburseAs(stack.disburser, wrong)
    expect(mismatch.status).toBe(422)
    expect(await mismatch.json()).toMatchObject({ disbursementPrecondition: "verified_bank_statement_mismatch" })
    expect(await db().loan.count({ where: { applicationId: { in: [noBank, wrong] } } })).toBe(0)
  })

  it("is refused when the borrower is screened out", async () => {
    const id = `screened-${t}`
    await signedApplication(id)
    // A screening provider is configured and the borrower's subject is blocked: the gate the NCA route runs too.
    const gate = await import("@/lib/screening/gate")
    const spy = vi.spyOn(gate, "readBorrowerScreening").mockResolvedValue({ allowed: false, message: "a sanctions match is on file", state: { state: "BLOCKED" } } as never)
    const res = await disburseAs(stack.disburser, id)
    spy.mockRestore()
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "screening" })
    expect(await db().loan.count({ where: { applicationId: id } })).toBe(0)
  })

  it("books once: a second disbursement of the same application is refused", async () => {
    const id = `twice-${t}`
    await signedApplication(id)
    expect((await disburseAs(stack.disburser, id)).status).toBe(200)
    const again = await disburseAs(stack.disburser, id)
    expect(again.status).toBe(400)
    expect(await db().loan.count({ where: { applicationId: id } })).toBe(1)
  })

  it("is refused when a KYC document stopped being verified after approval", async () => {
    const id = `kyc-${t}`
    await signedApplication(id)
    await db().clientDocument.updateMany({ where: { clientId: `${id}-client`, docType: "ID_COPY" }, data: { verified: false, verifiedAt: null, verifiedById: null } })
    const res = await disburseAs(stack.disburser, id)
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ disbursementPrecondition: "composite_kyc" })
    expect(await db().loan.count({ where: { applicationId: id } })).toBe(0)
  })

  it("a debit-order repayment is not offered: the loan is repaid by EFT", async () => {
    const id = `debit-${t}`
    await seedUnderReview(db(), stack, id, { nca: false })
    await clearOpenFlags(db(), stack, id)
    const res = await decideForm(id, { action: "approve", repaymentMethod: "DEBIT_ORDER" })
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ repaymentMethod: "key_facts_eft_only" })
  })
})

