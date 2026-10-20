import { randomInt, randomUUID } from "node:crypto"
import type { CollectionsStage, LoanStatus, PrismaClient } from "@prisma/client"
import { SCHEDULE_TOTAL, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { sastStartOfDay } from "@/lib/date/sast"
import { normalisePhone, toWaJid } from "@/lib/contact/identity"

// Shared real-Postgres fixture for the dunning-hold integration suites.
// Synthetic data only: every address is `.invalid` and every number is made up.

export interface HoldCase {
  name: string
  status?: LoanStatus
  stage?: CollectionsStage
  arrangement?: "ACTIVE" | "KEPT" | "BROKEN" | "COMPLETED"
  plan?: boolean
  deceased?: boolean
  /** A debt-review notice on THIS loan. */
  debtReview?: boolean
  /** A debt-review notice on ANOTHER loan of the same client (debt review is consumer-wide). */
  debtReviewOnSibling?: boolean
  held: boolean
}

export const HOLD_CASES: HoldCase[] = [
  { name: "normal ACTIVE", held: false },
  { name: "ACTIVE with a KEPT arrangement", arrangement: "KEPT", held: false },
  { name: "stage PAYMENT_ARRANGEMENT, arrangement BROKEN", stage: "PAYMENT_ARRANGEMENT", arrangement: "BROKEN", held: false },
  { name: "stage PAYMENT_ARRANGEMENT, arrangement COMPLETED", stage: "PAYMENT_ARRANGEMENT", arrangement: "COMPLETED", held: false },
  { name: "ACTIVE with an inactive payment plan", plan: false, held: false },
  { name: "stage PAYMENT_ARRANGEMENT, arrangement ACTIVE", stage: "PAYMENT_ARRANGEMENT", arrangement: "ACTIVE", held: true },
  { name: "ACTIVE arrangement row at stage NONE", arrangement: "ACTIVE", held: true },
  { name: "active payment plan", plan: true, held: true },
  { name: "stage ATTORNEY_REFERRED", stage: "ATTORNEY_REFERRED", held: true },
  { name: "stage WRITTEN_OFF", stage: "WRITTEN_OFF", held: true },
  { name: "deceased client", deceased: true, held: true },
  { name: "debt review on this loan", debtReview: true, held: true },
  { name: "debt review on the client's OTHER loan", debtReviewOnSibling: true, held: true },
  { name: "WRITTEN_OFF", status: "WRITTEN_OFF", held: true },
  { name: "PENDING_WRITE_OFF", status: "PENDING_WRITE_OFF", held: true },
  { name: "DEFAULTED", status: "DEFAULTED", held: true },
  { name: "CANCELLED", status: "CANCELLED", held: true },
  { name: "COMPLETED", status: "COMPLETED", held: true },
  { name: "RESTRUCTURED", status: "RESTRUCTURED", held: true },
]

export interface SeededHoldLoan extends HoldCase { loanId: string; clientId: string; contactId: string; email: string; phone: string; whatsapp: string }

export async function createSecondProduct(db: PrismaClient, tenantId: string): Promise<string> {
  const product = await db.loanProduct.create({
    data: {
      tenantId, code: "MICRO2", name: "Micro 2", productType: "MICRO", minAmount: 1, maxAmount: 1_000_000,
      minTermDays: 1, maxTermDays: 60, interestRatePm: 0.05, interestModel: "FLAT", monthlyServiceFee: 6_900,
    },
  })
  return product.id
}

interface LoanOptions { productId: string; status?: LoanStatus; stage?: CollectionsStage; debtReview?: boolean; inArrears?: boolean }

async function createLoan(db: PrismaClient, tenant: ChargesTenant, clientId: string, o: LoanOptions) {
  const id = randomUUID().replaceAll("-", "").slice(0, 12)
  const due = new Date(sastStartOfDay(new Date()).getTime() + 3 * 86_400_000)
  const app = await db.loanApplication.create({
    data: { tenantId: tenant.tenantId, reference: `APP-${id}`, clientId, productId: o.productId, appliedAmount: 200_000, appliedTermDays: 31 },
  })
  const loan = await db.loan.create({
    data: {
      tenantId: tenant.tenantId, reference: `LN-${id}`, applicationId: app.id, clientId, productId: o.productId,
      principal: 200_000, totalInterest: 10_000, initiationFee: 0, totalRepayable: SCHEDULE_TOTAL, outstandingPrincipal: 200_000,
      startDate: new Date(due.getTime() - 31 * 86_400_000), maturityDate: due,
      // The 7-day reminder fires on nextPaymentDate.
      nextPaymentDate: new Date(sastStartOfDay(new Date()).getTime() + 7 * 86_400_000),
      interestRatePm: 0.05, interestModel: "FLAT", monthlyServiceFee: 6_900,
      // CANCELLED is created ACTIVE and forced below: the guardLoanCancellation trigger refuses it without a reversal.
      status: o.status === "CANCELLED" ? "ACTIVE" : o.status ?? "ACTIVE", collectionsStage: o.stage ?? "NONE",
      debtReviewNoticeAt: o.debtReview ? new Date("2026-10-01T00:00:00+02:00") : null,
      ...(o.inArrears ? { daysInArrears: 65, arrearsAmount: 100_000 } : {}),
    },
  })
  // In arrears: the instalment fell due 65 days ago, so the nightly DPD pass
  // (which escalations and reminders run first when it has not) reproduces the
  // 65 DPD the loan row carries, instead of resetting it to 0.
  const scheduleDue = o.inArrears ? new Date(sastStartOfDay(new Date()).getTime() - 65 * 86_400_000) : due
  await db.repaymentSchedule.create({
    data: { tenantId: tenant.tenantId, loanId: loan.id, installmentNo: 1, dueDate: scheduleDue, principalDue: 200_000, interestDue: 10_000, feesDue: 6_900, totalDue: SCHEDULE_TOTAL },
  })
  if (o.status === "CANCELLED") {
    await db.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL session_replication_role = replica`
      await tx.$executeRaw`UPDATE "Loan" SET "status" = 'CANCELLED' WHERE "id" = ${loan.id}`
    })
  }
  return loan
}

/** One client with a Contact and one loan in the state `c` describes (plus a sibling loan for a consumer-wide case). */
export async function seedHoldLoan(
  db: PrismaClient, tenant: ChargesTenant, secondProductId: string, c: HoldCase, opts: { inArrears?: boolean } = {},
): Promise<SeededHoldLoan> {
  const id = randomUUID().replaceAll("-", "").slice(0, 12)
  const email = `hold-${id}@client.invalid`
  // Random, not numbered: a cron now sweeps every ACTIVE tenant, so rows left by an
  // earlier run or suite in a shared test database are reached too, and a number
  // that repeats from one run to the next would read as that loan's reminder.
  const digits = String(randomInt(10_000_000)).padStart(7, "0")
  const phone = `+2781${digits}`
  const whatsapp = `+2783${digits}`
  const client = await db.client.create({
    data: {
      tenantId: tenant.tenantId, idNumber: `91${id.slice(0, 11)}`, firstName: "Hold", lastName: c.name.slice(0, 20),
      email, phone, whatsapp, deceasedAt: c.deceased ? new Date("2026-09-01T00:00:00Z") : null, deceasedReason: c.deceased ? "synthetic" : null,
    },
  })
  const contact = await db.contact.create({
    data: {
      tenantId: tenant.tenantId, clientId: client.id, status: "CLIENT", firstSeenChannel: "MANUAL",
      primaryEmail: email, primaryPhone: phone, primaryWaJid: `${whatsapp.slice(1)}@s.whatsapp.net`,
    },
  })
  // The identities a reminder resolves its Contact through (lookupContactByChannelValue),
  // the email one included: what sendMessage resolves an email recipient from.
  await db.contactIdentity.createMany({
    data: [
      { tenantId: tenant.tenantId, contactId: contact.id, channel: "SMS", value: normalisePhone(phone), source: "MANUAL" },
      { tenantId: tenant.tenantId, contactId: contact.id, channel: "WHATSAPP", value: toWaJid(whatsapp), source: "MANUAL" },
      { tenantId: tenant.tenantId, contactId: contact.id, channel: "EMAIL", value: email, source: "MANUAL" },
    ],
  })
  const loan = await createLoan(db, tenant, client.id, { productId: tenant.productId, status: c.status, stage: c.stage, debtReview: c.debtReview, inArrears: opts.inArrears })
  if (c.debtReviewOnSibling) {
    await createLoan(db, tenant, client.id, { productId: secondProductId, debtReview: true })
  }
  if (c.arrangement) {
    await db.paymentArrangement.create({
      data: {
        tenantId: tenant.tenantId, loanId: loan.id, arrangementDate: new Date(), agreedAmount: 50_000, frequency: "MONTHLY",
        startDate: new Date(), endDate: new Date(Date.now() + 90 * 86_400_000), status: c.arrangement,
      },
    })
  }
  if (c.plan !== undefined) {
    await db.paymentPlan.create({
      data: { loanId: loan.id, totalArrears: 100_000, installments: 4, installmentAmt: 25_000, startDate: new Date(), createdBy: "synthetic", active: c.plan },
    })
  }
  return { ...c, loanId: loan.id, clientId: client.id, contactId: contact.id, email, phone, whatsapp }
}
