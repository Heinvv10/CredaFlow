/**
 * Real-Postgres proof of loan changes (migration 20261101100100_loan_changes): the database holds the rules whatever the code does, and refuses every
 * type of change on an NCA loan.
 *
 *   RUN_LOAN_CHANGES_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/loan-changes/
 *
 * Its own throwaway database (the instance jurisdiction is a property of the whole database): the role needs CREATEDB. Only
 * the session is stood in for: the routes, the service, the guards and the triggers are the real ones.
 */
import { randomUUID } from "node:crypto"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { createThrowawayDb, type ThrowawayDb } from "@/lib/jurisdiction/throwaway-db.integration-fixture"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { runWithTenant } from "@/lib/tenant-scope"

const holder = vi.hoisted(() => ({ prisma: null as unknown, tenantId: "", user: { id: "", email: "", role: "", totpVerified: true } }))
vi.mock("@/lib/prisma", async (original) => ({
  ...(await original<typeof import("@/lib/prisma")>()),
  prisma: new Proxy({}, { get: (_t, key) => (holder.prisma as Record<string | symbol, unknown>)[key] }),
}))
vi.mock("@/lib/auth-guards", async () => ({
  requireApiRole: vi.fn(async () => ({ error: null, user: holder.user })),
  canDo: (await vi.importActual<typeof import("@/lib/permissions")>("@/lib/permissions")).canDo,
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: async (_req: unknown, handler: (tenant: { id: string }) => Promise<unknown>) => await runWithTenant(holder.tenantId, () => handler({ id: holder.tenantId })),
}))

import { createAppPrismaClient } from "@/lib/prisma"
import { NCA_REFUSAL } from "./eligibility"
import { bookLoan, changeRoutes, type LoanFixture } from "./loan-changes.integration-fixture"
import { LOAN_CHANGE_KIND } from "./types"

const suite = process.env.RUN_LOAN_CHANGES_IT === "1" ? describe.sequential : describe.skip
const { draftAndSubmit, proposeAndApprove } = changeRoutes(holder)

suite("the database holds the rules (real Postgres, a Lesotho instance)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  const loan = () => bookLoan(db())

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
    holder.prisma = createAppPrismaClient(fresh.url)
  }, 240_000)
  afterAll(() => fresh?.drop())

  let l: LoanFixture
  let approved: string

  beforeAll(async () => {
    l = await loan()
    approved = await proposeAndApprove(l, { type: "RATE_CHANGE", interestRatePm: 0.03 })
  })

  const change = (over: Record<string, unknown>) => ({
    tenantId: l.tenantId, loanId: l.loanId, type: "RATE_CHANGE" as const, changeRequestId: randomUUID(), makerId: l.makerId, checkerId: l.checkerId, reason: "A direct write", signedDocumentId: l.documentId,
    before: {}, after: {}, scheduleBefore: [], scheduleAfter: [], ...over,
  })

  it("refuses a change no approved request made, and a second row for one request", async () => {
    await expect(db().loanChange.create({ data: change({}) })).rejects.toThrow(/only by an approved/)
    await expect(db().loanChange.create({ data: change({ changeRequestId: approved }) })).rejects.toThrow(/Unique|changeRequestId/)
  })

  it("an applied change never changes or goes away, and neither do its terms", async () => {
    const row = await db().loanChange.findFirstOrThrow({ where: { changeRequestId: approved } })
    await expect(db().loanChange.update({ where: { id: row.id }, data: { reason: "Rewritten" } })).rejects.toThrow(/never changes/)
    await expect(db().loanChange.delete({ where: { id: row.id } })).rejects.toThrow(/never changes/)
    await expect(db().$executeRawUnsafe(`TRUNCATE "LoanChange"`)).rejects.toThrow(/never changes/)
    await expect(db().loanTerms.deleteMany({ where: { loanId: l.loanId } })).rejects.toThrow(/never change/)
  })

  it("refuses later terms with no approved request", async () => {
    const next = (await db().loanTerms.count({ where: { loanId: l.loanId } })) + 1
    await expect(db().loanTerms.create({ data: { tenantId: l.tenantId, loanId: l.loanId, sequence: next, baseRatePm: 0.01, interestRatePm: 0.01, changeRequestId: "made-up" } })).rejects.toThrow(/approved LOAN_CHANGE/)
  })

  it("refuses an application claiming a request, and a request added to one later", async () => {
    await expect(db().loanApplication.create({
      data: { tenantId: l.tenantId, reference: `APP-${randomUUID()}`, clientId: l.fx.clientId, productId: l.fx.tenant.productId, appliedAmount: 100_000, appliedTermDays: 31, loanChangeRequestId: approved },
    })).rejects.toThrow(/approved top-up/)
    await expect(db().loanApplication.update({ where: { id: l.fx.applicationId }, data: { loanChangeRequestId: approved } })).rejects.toThrow(/never changes/)
  })

  it("refuses a settlement receipt no change made, and a reversal of a real one", async () => {
    await expect(db().payment.create({ data: { tenantId: l.tenantId, loanId: l.loanId, amount: 100, paymentMethod: "LOAN_SETTLEMENT" } })).rejects.toThrow(/approved change settled/)
    const r = await loan()
    await proposeAndApprove(r, { type: "REFINANCE", instalments: 12 })
    const receipt = await db().payment.findFirstOrThrow({ where: { loanId: r.loanId, paymentMethod: "LOAN_SETTLEMENT" } })
    await expect(db().payment.update({ where: { id: receipt.id }, data: { reversed: true } })).rejects.toThrow(/never reversed/)
  })

  it("refuses to commit a change whose schedule does not reconcile to the cent", async () => {
    const r = await loan()
    const request = await db().changeRequest.create({ data: { tenantId: r.tenantId, kind: LOAN_CHANGE_KIND, title: "Direct", payload: { type: "RATE_CHANGE", loanId: r.loanId, reason: "Direct", signedDocumentId: r.documentId, interestRatePm: 0.01 }, makerId: r.makerId } })
    await db().changeRequest.update({ where: { id: request.id }, data: { status: "SUBMITTED", submittedAt: new Date() } })
    await db().changeRequest.update({ where: { id: request.id }, data: { status: "APPROVED", checkerId: r.checkerId, decidedAt: new Date(), appliedAt: new Date() } })
    const write = (cents: number) => db().$transaction(async (tx) => {
      await tx.repaymentSchedule.updateMany({ where: { loanId: r.loanId, installmentNo: 6 }, data: { principalDue: { increment: cents }, totalDue: { increment: cents } } })
      await tx.loanChange.create({ data: change({ loanId: r.loanId, changeRequestId: request.id, makerId: r.makerId, checkerId: r.checkerId, signedDocumentId: r.documentId, tenantId: r.tenantId }) })
      await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
    })
    await expect(write(1)).rejects.toThrow(/to the cent/)
    await write(0)
    expect(await db().loanChange.count({ where: { changeRequestId: request.id } })).toBe(1)
  })
})

suite("loan changes on a South African instance (real Postgres, real routes)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  beforeAll(async () => {
    fresh = await createThrowawayDb()
    holder.prisma = createAppPrismaClient(fresh.url)
  }, 240_000)
  afterAll(() => fresh?.drop())

  it("refuses every type of change on an NCA loan, and the database refuses it too", async () => {
    const tenant = await createChargesTenant(db(), false)
    const created = await createChargesLoan(db(), tenant)
    const ncaLoan = await db().loan.findFirstOrThrow({ where: { tenantId: tenant.tenantId } })
    expect(created).toBeTruthy()
    const document = await db().clientDocument.create({
      data: { tenantId: tenant.tenantId, clientId: ncaLoan.clientId!, docType: "OTHER", fileName: "x.pdf", fileUrl: "", storagePath: "/synthetic/x.pdf", fileSize: 1, mimeType: "application/pdf", uploadedByType: "staff", extractionStatus: "skipped", verified: false },
    })
    const old = new Date(Date.now() - 90 * 86_400_000)
    const makerId = `u_m_${tenant.tenantId}`
    const checkerId = `u_c_${tenant.tenantId}`
    await db().user.create({ data: { id: makerId, tenantId: tenant.tenantId, email: `${makerId}@test.invalid`, password: "x", role: "LOAN_ADMIN", createdAt: old } })
    await db().user.create({ data: { id: checkerId, tenantId: tenant.tenantId, email: `${checkerId}@test.invalid`, password: "x", role: "ADMIN", createdAt: old } })
    const l = { fx: { clientId: ncaLoan.clientId!, tenant }, loanId: ncaLoan.id, documentId: document.id, makerId, checkerId, tenantId: tenant.tenantId } as unknown as LoanFixture

    const scheduleBefore = await db().repaymentSchedule.findMany({ where: { loanId: ncaLoan.id } })
    const cases = [
      { type: "RESCHEDULE", firstDueDate: "2099-01-01" }, { type: "RESTRUCTURE", instalments: 12 }, { type: "PAYMENT_HOLIDAY", holidayInstalments: 1 },
      { type: "RATE_CHANGE", interestRatePm: 0.01 }, { type: "TERM_CHANGE", instalments: 12 },
      { type: "TOP_UP", newMoneyCents: 100, payoutReference: "EFT-1", instalments: 12 }, { type: "REFINANCE", instalments: 12 }, { type: "CONSOLIDATION", otherLoanIds: ["other"], instalments: 12 },
    ]
    for (const payload of cases) {
      const { submitted } = await draftAndSubmit(l, payload)
      expect(submitted.status).toBe(422)
      expect(((await submitted.json()) as { error: string }).error).toContain(NCA_REFUSAL)
    }
    expect(await db().repaymentSchedule.findMany({ where: { loanId: ncaLoan.id } })).toEqual(scheduleBefore)

    // Even an approved request cannot write one: only the service refuses it above, and the trigger refuses it here.
    const request = await db().changeRequest.create({ data: { tenantId: tenant.tenantId, kind: LOAN_CHANGE_KIND, title: "Direct", payload: { type: "RATE_CHANGE", loanId: ncaLoan.id, reason: "Direct", signedDocumentId: document.id, interestRatePm: 0.01 }, makerId } })
    await db().changeRequest.update({ where: { id: request.id }, data: { status: "SUBMITTED", submittedAt: new Date() } })
    await db().changeRequest.update({ where: { id: request.id }, data: { status: "APPROVED", checkerId, decidedAt: new Date(), appliedAt: new Date() } })
    await expect(db().loanChange.create({
      data: { tenantId: tenant.tenantId, loanId: ncaLoan.id, type: "RATE_CHANGE", changeRequestId: request.id, makerId, checkerId, reason: "Direct write", signedDocumentId: document.id, before: {}, after: {}, scheduleBefore: [], scheduleAfter: [] },
    })).rejects.toThrow(/NCA/)
  })
})
