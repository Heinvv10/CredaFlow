import { randomUUID } from "node:crypto"
import { Prisma, type ContractType, type PrismaClient } from "@prisma/client"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { dbDate } from "./dates"
import { dueDateInstant, toScheduleRecord } from "./schedule-records"
import { solveStructure } from "./structure"
import { monthly } from "./structure-presets"
import type { StructureInput, StructureResult } from "./types"

// Shared real-Postgres fixture for the repricing integration tests. Synthetic
// only: an excavator deal for "Test Plant Hire (Pty) Ltd", R1 250 000 incl.
// VAT, 10% deposit, 20% balloon, 60 months at prime 11.75% + 1% = 12.75%.
export const DEAL: StructureInput = {
  cashPriceCents: 125_000_000,
  depositCents: 12_500_000,
  tradeInCents: 0,
  financedFeesCents: 150_000,
  balloonCents: 25_000_000,
  weights: monthly(60),
  startDate: "2026-01-15",
  ratePath: [{ effectiveDate: "2026-01-15", annualRate: 0.1275 }],
}
export const BOOKED = solveStructure(DEAL)
export const PAID_ROWS = 12 // rows 1..12 settled
export const MARGIN = "0.01"

export interface RepriceTenant {
  tenantId: string; adminId: string; approverId: string; productId: string; entityId: string; directorId: string
}

/** A PENDING prime value recorded by the admin: the only shape the database accepts on INSERT. */
export function pendingPrime(db: PrismaClient, tenant: RepriceTenant, effectiveDate: string, rate: string) {
  return db.referenceRate.create({
    data: { tenantId: tenant.tenantId, basis: "PRIME", effectiveDate: dbDate(effectiveDate), rate: new Prisma.Decimal(rate), requestedById: tenant.adminId },
  })
}

/** An APPROVED prime value: recorded by the admin, then approved by the second user (four-eyes). */
export async function approvedPrime(db: PrismaClient, tenant: RepriceTenant, effectiveDate: string, rate: string) {
  const pending = await pendingPrime(db, tenant, effectiveDate, rate)
  return db.referenceRate.update({
    where: { id: pending.id },
    data: { status: "APPROVED", decidedById: tenant.approverId, decidedAt: new Date() },
  })
}

/** A tenant with asset finance on (or off), two loan admins, an entity borrower, and prime 11.75% approved from the deal's start. */
export async function createRepriceTenant(db: PrismaClient, featureAssetFinance = true): Promise<RepriceTenant> {
  const t = randomUUID().replaceAll("-", "").slice(0, 16)
  const tenantId = `t_rp_${t}`
  await db.tenant.create({ data: { id: tenantId, slug: `rp-${t}`, name: "Reprice IT" } })
  await db.tenantConfig.create({ data: { ...VALID_LENDER_COLUMNS, tenantId, featureAssetFinance } })
  const admin = await db.user.create({
    data: { id: `u_rp_${t}`, tenantId, email: `${t}@test.invalid`, password: "x", role: "LOAN_ADMIN" },
  })
  // Not a LOAN_ADMIN, so the repricing bell goes to the admin alone.
  const approver = await db.user.create({
    data: { id: `u_rp2_${t}`, tenantId, email: `approver-${t}@test.invalid`, password: "x", role: "CREDIT_OFFICER" },
  })
  const product = await db.loanProduct.create({
    data: {
      tenantId, code: "AF-IS", name: "Instalment sale", productType: "PERSONAL",
      minAmount: 1, maxAmount: 500_000_000, minTermDays: 1, maxTermDays: 2_000,
      interestRatePm: 0.010625, interestModel: "REDUCING_BALANCE", monthlyServiceFee: 0,
    },
  })
  const entity = await db.businessEntity.create({
    data: { tenantId, type: "COMPANY", legalName: "Test Plant Hire (Pty) Ltd", registrationNumber: `2099/${t.slice(0, 6)}/07` },
  })
  const client = (role: string, digit: number) => db.client.create({
    data: {
      id: `c_rp_${role}_${t}`, tenantId, idNumber: `9${digit}${t.slice(0, 11)}`, firstName: "Test",
      lastName: role, email: `${role}.${t}@client.invalid`, phone: "0820000000",
    },
  })
  const director = await client("director", 1)
  const surety = await client("surety", 2)
  const formerDirector = await client("former", 3)
  await db.entityRelationship.createMany({
    data: [
      { tenantId, entityId: entity.id, clientId: director.id, role: "DIRECTOR" },
      { tenantId, entityId: entity.id, clientId: director.id, role: "AUTHORISED_SIGNATORY" },
      { tenantId, entityId: entity.id, clientId: surety.id, role: "SURETY" },
      { tenantId, entityId: entity.id, clientId: formerDirector.id, role: "DIRECTOR", active: false },
    ],
  })
  const tenant = { tenantId, adminId: admin.id, approverId: approver.id, productId: product.id, entityId: entity.id, directorId: director.id }
  await approvedPrime(db, tenant, DEAL.startDate, "0.1175")
  return tenant
}

export type RateBooking = { basis: "PRIME"; margin: string } | { basis: "FIXED"; fixedRate: string }

export interface LoanOptions {
  rate?: RateBooking | null // null: no contract rate (a contract the ContractRate guard refuses)
  weights?: number[]
  contractType?: ContractType
  paidRows?: number
}

/** The deal solved with `weights`; rows 0..paidRows-1 that have something due are settled. */
export function bookedWith(weights: number[]): StructureResult {
  return solveStructure({ ...DEAL, weights })
}

/**
 * A booked, part-paid NON_NCA asset-finance loan with its stored schedule and
 * its booking contract rate (which records the solved base instalment). The
 * Loan totals are the schedule's sums (lib/asset-finance/schedule-records.ts),
 * and the contractual totals start equal to them, as disbursement records them.
 */
export async function createRepriceLoan(db: PrismaClient, tenant: RepriceTenant, options: LoanOptions = {}) {
  const n = randomUUID().replaceAll("-", "").slice(0, 12)
  const { tenantId } = tenant
  const rate = options.rate === undefined ? { basis: "PRIME" as const, margin: MARGIN } : options.rate
  const booked = options.weights ? bookedWith(options.weights) : BOOKED
  const paidRows = options.paidRows ?? PAID_ROWS
  const records = booked.rows.map(toScheduleRecord)
  const settled = (i: number) => i < paidRows && records[i].totalDue > 0
  const sum = (pick: (r: (typeof records)[number]) => number, only: (i: number) => boolean = () => true) =>
    records.reduce((total, r, i) => total + (only(i) ? pick(r) : 0), 0)
  const last = booked.rows.length - 1
  // The application reaches NON_NCA the only way the database allows: it is
  // classified NCA, a second person approves an NCA → NON_NCA override, and the
  // flip consumes that approval (guardLoanApplicationNcaRegime). It is then
  // approved, and booking and disbursement commit together
  // (assertDisbursedCreditLifeCoverage), exactly as asset-finance booking does.
  const loan = await db.$transaction(async (tx) => {
    const app = await tx.loanApplication.create({
      data: {
        tenantId, reference: `APP-RP-${n}`, entityId: tenant.entityId, productId: tenant.productId,
        appliedAmount: booked.financedAmountCents, appliedTermDays: 1_826, status: "UNDER_REVIEW",
        ncaRegime: "NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD", ncaClassifiedAt: new Date(),
        ncaClassifiedById: tenant.adminId,
      },
    })
    const override = await tx.ncaRegimeOverride.create({
      data: {
        tenantId, applicationId: app.id, fromRegime: "NCA", toRegime: "NON_NCA",
        reason: "Classifier: JURISTIC_OVER_THRESHOLD (fixture)", requestedById: tenant.adminId, source: "CLASSIFIER",
        approvedEntityId: tenant.entityId, approvedAppliedAmount: booked.financedAmountCents,
        approvedProductId: tenant.productId, approvedClassificationRule: "JURISTIC_OVER_THRESHOLD",
        approvedClassifiedAt: app.ncaClassifiedAt,
      },
    })
    await tx.ncaRegimeOverride.update({
      where: { id: override.id },
      data: { status: "APPROVED", decidedById: tenant.approverId, decidedAt: new Date() },
    })
    await tx.loanApplication.update({ where: { id: app.id }, data: { ncaRegime: "NON_NCA" } })
    await tx.loanApplication.update({
      where: { id: app.id },
      data: { status: "APPROVED", repaymentMethod: "EFT", approvedAt: new Date(), approvedById: tenant.adminId },
    })
    const created = await tx.loan.create({
      data: {
        tenantId, reference: `LN-RP-${n}`, applicationId: app.id, entityId: tenant.entityId, productId: tenant.productId,
        ncaRegime: "NON_NCA", contractType: options.contractType ?? "INSTALMENT_SALE", balloonAmount: DEAL.balloonCents,
        assetFinanceWeights: DEAL.weights,
        principal: sum((r) => r.principalDue), totalInterest: sum((r) => r.interestDue), initiationFee: 0,
        totalRepayable: sum((r) => r.totalDue), outstandingPrincipal: sum((r) => r.principalDue, (i) => !settled(i)),
        contractualTotalInterest: sum((r) => r.interestDue), contractualTotalRepayable: sum((r) => r.totalDue),
        totalPaid: sum((r) => r.totalDue, settled),
        startDate: dueDateInstant(DEAL.startDate), maturityDate: dueDateInstant(booked.rows[last].dueDate),
        interestRatePm: 0.1275 / 12, interestModel: "REDUCING_BALANCE", status: "ACTIVE", monthlyServiceFee: 0,
      },
    })
    await tx.loanApplication.update({ where: { id: app.id }, data: { status: "DISBURSED", disbursedAt: new Date() } })
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return created
  })
  await db.repaymentSchedule.createMany({
    data: records.map((record, i) => ({
      ...record, tenantId, loanId: loan.id, assetFinanceOpeningBalanceCents: booked.rows[i].openingBalanceCents,
      ...(settled(i) ? { status: "PAID" as const, totalPaid: record.totalDue, paidAt: record.dueDate } : {}),
    })),
  })
  if (rate) {
    await db.contractRate.create({
      data: {
        tenantId, loanId: loan.id, effectiveDate: dbDate(DEAL.startDate), basis: rate.basis, newInstalmentCents: booked.baseInstalmentCents,
        ...(rate.basis === "FIXED"
          ? { fixedRate: new Prisma.Decimal(rate.fixedRate), resultingRate: new Prisma.Decimal(rate.fixedRate) }
          : { margin: new Prisma.Decimal(rate.margin), resultingRate: new Prisma.Decimal("0.1275") }),
      },
    })
  }
  return loan.id
}

/** Prime 12.00% approved from row 12's due date; returns that date. */
export async function recordPrime(db: PrismaClient, tenant: RepriceTenant): Promise<string> {
  const effectiveDate = BOOKED.rows[PAID_ROWS - 1].dueDate
  await approvedPrime(db, tenant, effectiveDate, "0.12")
  return effectiveDate
}
