import { randomUUID } from "node:crypto"
import { Prisma, type PrismaClient } from "@prisma/client"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"
import { dbDate } from "./rates-store"
import { dueDateInstant, toScheduleRecord } from "./schedule-records"
import { solveStructure } from "./structure"
import { monthly } from "./structure-presets"
import type { StructureInput } from "./types"

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

export interface RepriceTenant { tenantId: string; adminId: string; productId: string; entityId: string; directorId: string }

export async function createRepriceTenant(db: PrismaClient): Promise<RepriceTenant> {
  const t = randomUUID().replaceAll("-", "").slice(0, 16)
  const tenantId = `t_rp_${t}`
  await db.tenant.create({ data: { id: tenantId, slug: `rp-${t}`, name: "Reprice IT" } })
  await db.tenantConfig.create({ data: { ...VALID_LENDER_COLUMNS, tenantId, featureAssetFinance: true } })
  const admin = await db.user.create({
    data: { id: `u_rp_${t}`, tenantId, email: `${t}@test.invalid`, password: "x", role: "LOAN_ADMIN" },
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
  return { tenantId, adminId: admin.id, productId: product.id, entityId: entity.id, directorId: director.id }
}

export type RateBooking = { basis: "PRIME"; margin: string } | { basis: "FIXED"; fixedRate: string }

/** A booked, part-paid NON_NCA instalment sale with its schedule and booking contract rate. */
export async function createRepriceLoan(db: PrismaClient, tenant: RepriceTenant, rate: RateBooking = { basis: "PRIME", margin: MARGIN }) {
  const n = randomUUID().replaceAll("-", "").slice(0, 12)
  const { tenantId } = tenant
  const totalInterest = BOOKED.totalInterestCents
  const paidRows = BOOKED.rows.slice(0, PAID_ROWS)
  // The application reaches NON_NCA the only way the database allows: it is
  // classified NCA, a second person approves an NCA → NON_NCA override, and the
  // flip consumes that approval (guardLoanApplicationNcaRegime). It is then
  // approved, and booking and disbursement commit together
  // (assertDisbursedCreditLifeCoverage), exactly as asset-finance booking does.
  const loan = await db.$transaction(async (tx) => {
    const app = await tx.loanApplication.create({
      data: {
        tenantId, reference: `APP-RP-${n}`, entityId: tenant.entityId, productId: tenant.productId,
        appliedAmount: BOOKED.financedAmountCents, appliedTermDays: 1_826, status: "UNDER_REVIEW",
        ncaRegime: "NCA", ncaClassificationRule: "JURISTIC_OVER_THRESHOLD", ncaClassifiedAt: new Date(),
        ncaClassifiedById: tenant.adminId,
      },
    })
    const override = await tx.ncaRegimeOverride.create({
      data: {
        tenantId, applicationId: app.id, fromRegime: "NCA", toRegime: "NON_NCA",
        reason: "Classifier: JURISTIC_OVER_THRESHOLD (fixture)", requestedById: tenant.adminId,
      },
    })
    await tx.ncaRegimeOverride.update({
      where: { id: override.id },
      data: { status: "APPROVED", decidedById: `second-approver-${n}`, decidedAt: new Date() },
    })
    await tx.loanApplication.update({ where: { id: app.id }, data: { ncaRegime: "NON_NCA" } })
    await tx.loanApplication.update({
      where: { id: app.id },
      data: { status: "APPROVED", repaymentMethod: "EFT", approvedAt: new Date(), approvedById: tenant.adminId },
    })
    const created = await tx.loan.create({
      data: {
        tenantId, reference: `LN-RP-${n}`, applicationId: app.id, entityId: tenant.entityId, productId: tenant.productId,
        ncaRegime: "NON_NCA", contractType: "INSTALMENT_SALE", balloonAmount: DEAL.balloonCents,
        principal: BOOKED.financedAmountCents, totalInterest, initiationFee: 0, totalRepayable: BOOKED.totalPayableCents,
        outstandingPrincipal: BOOKED.rows[PAID_ROWS - 1].closingBalanceCents,
        totalPaid: paidRows.reduce((sum, r) => sum + r.totalCents, 0),
        startDate: dueDateInstant(DEAL.startDate), maturityDate: dueDateInstant(BOOKED.rows[59].dueDate),
        interestRatePm: 0.1275 / 12, interestModel: "REDUCING_BALANCE", status: "ACTIVE", monthlyServiceFee: 0,
      },
    })
    await tx.loanApplication.update({ where: { id: app.id }, data: { status: "DISBURSED", disbursedAt: new Date() } })
    await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
    return created
  })
  await db.repaymentSchedule.createMany({
    data: BOOKED.rows.map((row, i) => ({
      ...toScheduleRecord(row), tenantId, loanId: loan.id,
      ...(i < PAID_ROWS ? { status: "PAID" as const, totalPaid: row.totalCents, paidAt: dueDateInstant(row.dueDate) } : {}),
    })),
  })
  await db.contractRate.create({
    data: {
      tenantId, loanId: loan.id, effectiveDate: dbDate(DEAL.startDate), basis: rate.basis,
      ...(rate.basis === "FIXED"
        ? { fixedRate: new Prisma.Decimal(rate.fixedRate), resultingRate: new Prisma.Decimal(rate.fixedRate) }
        : { margin: new Prisma.Decimal(rate.margin), resultingRate: new Prisma.Decimal("0.1275") }),
    },
  })
  return loan.id
}

/** Prime history: 11.75% at booking, 12.00% from row 12's due date. */
export async function recordPrime(db: PrismaClient, tenantId: string): Promise<string> {
  const effectiveDate = BOOKED.rows[PAID_ROWS - 1].dueDate
  await db.referenceRate.createMany({
    data: [
      { tenantId, basis: "PRIME", effectiveDate: dbDate(DEAL.startDate), rate: new Prisma.Decimal("0.1175") },
      { tenantId, basis: "PRIME", effectiveDate: dbDate(effectiveDate), rate: new Prisma.Decimal("0.12") },
    ],
  })
  return effectiveDate
}
