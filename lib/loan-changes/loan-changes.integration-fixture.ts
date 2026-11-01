/**
 * Fixtures for the loan-change suites: a Lesotho (KEY_FACTS) lender, staff, and a booked loan whose application went
 * through the document gate as a real one does. Real Postgres; every value synthetic. Not a test file.
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { expect } from "vitest"
import { POST as draftRoute } from "@/app/api/maker-checker/route"
import { POST as actionRoute } from "@/app/api/maker-checker/[id]/[action]/route"
import { LOAN_CHANGE_KIND } from "./types"
import { addCalendarMonths } from "@/lib/product-engine/periods"
import { generateSchedule } from "@/lib/product-engine/schedule"
import { createApprovedApplication, issueBoth, signData, type KeyFactsFixture } from "@/lib/non-nca-documents/gate.integration-fixture"

export interface LoanFixture {
  fx: KeyFactsFixture
  loanId: string
  documentId: string
  makerId: string
  checkerId: string
  tenantId: string
}

export interface LoanOptions {
  principal?: number
  instalments?: number
  /** Whole months the loan has run, plus five days: that many instalments have fallen due. */
  monthsRun?: number
  /** The same borrower as this fixture, for a consolidation. */
  sameClientAs?: LoanFixture
  status?: "ACTIVE" | "DEFAULTED"
}

async function bookedApplication(db: PrismaClient, sameClientAs?: LoanFixture): Promise<KeyFactsFixture> {
  const fx = await createApprovedApplication(db)
  if (!sameClientAs) return fx
  // A second application of the first borrower, under the first lender: its documents are that lender's.
  const n = randomUUID().replaceAll("-", "").slice(0, 10)
  const first = sameClientAs.fx
  const application = await db.loanApplication.create({
    data: { tenantId: first.tenant.tenantId, reference: `APP-KF2-${n}`, clientId: first.clientId, productId: first.tenant.productId, appliedAmount: 200_000, appliedTermDays: 31 },
  })
  await db.loanApplication.update({ where: { id: application.id }, data: { status: "SUBMITTED" } })
  await db.loanApplication.update({ where: { id: application.id }, data: { status: "UNDER_REVIEW" } })
  await db.loanApplication.update({
    where: { id: application.id },
    data: { status: "APPROVED", approvedAt: new Date(), approvedById: first.tenant.userId, approvedAmount: 200_000, approvedTermDays: 31, repaymentMethod: "EFT" },
  })
  return { ...first, applicationId: application.id }
}

/** A REDUCING_BALANCE loan at 4% a month on the lender's product, its rows from the engine. Nothing paid. */
export async function bookLoan(db: PrismaClient, options: LoanOptions = {}): Promise<LoanFixture> {
  const { principal = 600_000, instalments = 6, monthsRun = 3, status = "ACTIVE" } = options
  const fx = await bookedApplication(db, options.sameClientAs)
  await issueBoth(db, fx)
  await db.loanApplication.update({ where: { id: fx.applicationId }, data: signData() })
  const now = new Date()
  const startDate = new Date(addCalendarMonths(now, -monthsRun).getTime() - 5 * 86_400_000)
  const terms = { frequency: "MONTHLY", structure: "AMORTISING", graceKind: "NONE", graceInstalments: 0, instalments } as const
  const { schedule, totalInterest } = generateSchedule({ principalCents: principal, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", monthlyServiceFeeCents: 5_000, startDate, terms })
  const totalRepayable = schedule.reduce((sum, row) => sum + row.totalDue, 0)
  const n = randomUUID().replaceAll("-", "").slice(0, 12)
  const loanId = `l_lc_${n}`
  await db.$transaction(async (tx) => {
    await tx.loan.create({
      data: {
        id: loanId, tenantId: fx.tenant.tenantId, reference: `LN-LC-${n}`, applicationId: fx.applicationId, clientId: fx.clientId, productId: fx.tenant.productId,
        principal, totalInterest, initiationFee: 0, totalRepayable, contractualTotalInterest: totalInterest, contractualTotalRepayable: totalRepayable, outstandingPrincipal: principal,
        startDate, maturityDate: schedule.at(-1)!.dueDate, nextPaymentDate: schedule[0]!.dueDate, interestRatePm: 0.04, interestModel: "REDUCING_BALANCE", status, monthlyServiceFee: 5_000,
      },
    })
    await tx.repaymentSchedule.createMany({
      data: schedule.map((row) => ({
        tenantId: fx.tenant.tenantId, loanId, installmentNo: row.installmentNo, dueDate: row.dueDate, principalDue: row.principalDue, interestDue: row.interestDue, feesDue: row.feesDue, totalDue: row.totalDue,
      })),
    })
    await tx.loanApplication.update({ where: { id: fx.applicationId }, data: { status: "DISBURSED", disbursedAt: startDate, disbursedById: fx.disburserId } })
    await tx.$executeRaw`SET CONSTRAINTS ALL IMMEDIATE`
  })
  const document = await db.clientDocument.create({
    data: {
      tenantId: fx.tenant.tenantId, clientId: fx.clientId, docType: "OTHER", fileName: "signed-variation.pdf", fileUrl: "", storagePath: `/synthetic/${n}.pdf`, fileSize: 1, mimeType: "application/pdf",
      uploadedByType: "staff", extractionStatus: "skipped", verified: false,
    },
  })
  // The maker-checker pair: accounts older than 30 days, on a lender whose product allows the sizes these suites use.
  const old = new Date(Date.now() - 90 * 86_400_000)
  const makerId = `u_lm_${n}`
  const checkerId = `u_lc_${n}`
  await db.user.create({ data: { id: makerId, tenantId: fx.tenant.tenantId, email: `${makerId}@test.invalid`, password: "x", role: "LOAN_ADMIN", createdAt: old } })
  await db.user.create({ data: { id: checkerId, tenantId: fx.tenant.tenantId, email: `${checkerId}@test.invalid`, password: "x", role: "ADMIN", createdAt: old } })
  await db.loanProduct.update({ where: { id: fx.tenant.productId }, data: { maxAmount: 100_000_000, maxTermDays: 1_800 } })
  return { fx, loanId, documentId: document.id, makerId, checkerId, tenantId: fx.tenant.tenantId }
}

export interface RouteHolder {
  tenantId: string
  user: { id: string; email: string; role: string; totpVerified: boolean }
}

/** Calls the real maker-checker routes as the fixture's maker or checker; a suite's mocks read `holder` for the session. */
export function changeRoutes(holder: RouteHolder) {
  const req = (body?: unknown) => new NextRequest("http://lender.test/api", { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const params = <T,>(value: T) => ({ params: Promise.resolve(value) })
  function as(l: LoanFixture, who: "maker" | "checker") {
    holder.tenantId = l.tenantId
    const id = who === "maker" ? l.makerId : l.checkerId
    holder.user = { id, email: `${id}@test.invalid`, role: who === "maker" ? "LOAN_ADMIN" : "ADMIN", totpVerified: true }
  }
  async function draftAndSubmit(l: LoanFixture, payload: Record<string, unknown>) {
    as(l, "maker")
    const body = { kind: LOAN_CHANGE_KIND, title: `Change ${payload.type as string}`, payload: { loanId: l.loanId, reason: "Borrower asked; income fell", signedDocumentId: l.documentId, ...payload } }
    const drafted = await draftRoute(req(body))
    expect(drafted.status).toBe(201)
    const id = ((await drafted.json()) as { request: { id: string } }).request.id
    const submitted = await actionRoute(req({}), params({ id, action: "submit" }))
    return { id, submitted }
  }
  async function proposeAndApprove(l: LoanFixture, payload: Record<string, unknown>) {
    const { id, submitted } = await draftAndSubmit(l, payload)
    expect(submitted.status).toBe(200)
    as(l, "checker")
    expect((await actionRoute(req({ note: "Seen the paper" }), params({ id, action: "approve" }))).status).toBe(200)
    return id
  }
  return { as, req, params, draftAndSubmit, proposeAndApprove }
}
