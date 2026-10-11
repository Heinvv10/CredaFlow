import { randomUUID } from "node:crypto"
import type { PrismaClient } from "@prisma/client"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

// Shared real-Postgres fixture for the default-charges integration tests.
//
// R2,000 FLAT bullet due 1 Sep: R100 interest + R69 fee = R2,169. On 26 Sep,
// Sep 2..25 are 24 completed days of default interest at 5% / 30 on R2,000.
export const NOW = new Date("2026-09-26T10:00:00+02:00")
export const SCHEDULE_TOTAL = 216_900
export const DEFAULT_INTEREST = 8_000

export interface ChargesTenant { tenantId: string; userId: string; productId: string }

export async function createChargesTenant(db: PrismaClient, enabled = true): Promise<ChargesTenant> {
  const t = randomUUID().replaceAll("-", "").slice(0, 16)
  const ids = { tenantId: `t_chg_${t}`, userId: `u_chg_${t}` }
  await db.tenant.create({ data: { id: ids.tenantId, slug: `chg-${t}`, name: "Charges IT" } })
  // Go-live well before the fixture loan, so no cut-off applies unless a test
  // sets its own. A complete synthetic lender identity, because the statement,
  // certificate of balance and NCR return refuse to render without one.
  await db.tenantConfig.create({
    data: {
      ...VALID_LENDER_COLUMNS,
      tenantId: ids.tenantId,
      defaultChargesEnabled: enabled,
      defaultChargesStartedAt: enabled ? new Date("2026-01-01T00:00:00+02:00") : null,
    },
  })
  await db.user.create({
    data: { id: ids.userId, tenantId: ids.tenantId, email: `${t}@test.invalid`, password: "x", role: "SUPER_ADMIN" },
  })
  const product = await db.loanProduct.create({
    data: {
      tenantId: ids.tenantId, code: "MICRO", name: "Micro", productType: "MICRO",
      minAmount: 1, maxAmount: 1_000_000, minTermDays: 1, maxTermDays: 60,
      interestRatePm: 0.05, interestModel: "FLAT", monthlyServiceFee: 6_900,
    },
  })
  return { ...ids, productId: product.id }
}

// MICRO30's shape: R2,000 DAILY_ACCRUAL 30-day bullet at 5% / 30 a day, from
// 11 Sep to 11 Oct, so NOW is day 15 (R50 accrued of R100). s125 settles it on
// NOW for R2,169 - R100 + R50 = R2,119.
export const DAILY_START = new Date("2026-09-11T10:00:00+02:00")
export const DAILY_MATURITY = new Date("2026-10-11T10:00:00+02:00")
export const DAILY_SETTLEMENT_NOW = 211_900

export async function createChargesLoan(db: PrismaClient, tenant: ChargesTenant, opts: { dailyAccrual?: boolean } = {}) {
  const startDate = opts.dailyAccrual ? DAILY_START : new Date("2026-08-01T10:00:00+02:00")
  const dueDate = opts.dailyAccrual ? DAILY_MATURITY : new Date("2026-09-01T10:00:00+02:00")
  const n = randomUUID().replaceAll("-", "").slice(0, 12)
  const loanId = `l_chg_${n}`
  // One client per loan: an application is unique per (tenant, client, product).
  const clientId = `c_chg_${n}`
  await db.client.create({
    data: {
      id: clientId, tenantId: tenant.tenantId, idNumber: `90${n.slice(0, 11)}`,
      firstName: "Charge", lastName: "Test", email: `${n}@client.invalid`, phone: "0820000000",
    },
  })
  const app = await db.loanApplication.create({
    data: {
      tenantId: tenant.tenantId, reference: `APP-${n}`, clientId,
      productId: tenant.productId, appliedAmount: 200_000, appliedTermDays: 31,
    },
  })
  await db.loan.create({
    data: {
      id: loanId, tenantId: tenant.tenantId, reference: `LN-${n}`, applicationId: app.id,
      clientId, productId: tenant.productId, principal: 200_000, totalInterest: 10_000,
      initiationFee: 0, totalRepayable: SCHEDULE_TOTAL, outstandingPrincipal: 200_000,
      startDate, maturityDate: dueDate,
      interestRatePm: 0.05, interestModel: opts.dailyAccrual ? "DAILY_ACCRUAL" : "FLAT", status: "ACTIVE", monthlyServiceFee: 6_900,
    },
  })
  await db.repaymentSchedule.create({
    data: {
      tenantId: tenant.tenantId, loanId, installmentNo: 1,
      dueDate, principalDue: 200_000,
      interestDue: 10_000, feesDue: 6_900, totalDue: SCHEDULE_TOTAL,
    },
  })
  return { ...tenant, loanId, clientId }
}
