/**
 * Default charges inside a recovery's settlement, against figures worked by
 * hand rather than by the code under test. A fixed overdue schedule on an NCA
 * attachment recovery, the sale and the proceeds through the real routes:
 * the settlement the proceeds are applied against is the contract plus the
 * default interest owed on the day, so the receipt, the charges it pays and
 * the surplus follow to the cent. (The charge freeze starts on the day the
 * proceeds are applied and the database insists that day is today, so the
 * clock cannot be pinned: scenario 1 is independent of the date by the
 * in duplum cap, scenario 2's expectation follows the calendar by a formula
 * worked below.) The legal rules are UNTESTED against the law.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-gaps-charges.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { sastCalendarDate } from "@/lib/date/sast"
import { fromDayNumber, toDayNumber } from "./dates"
import { ladderRecovery, recordDecidedCost } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { testSetup } from "./lease-servicing.integration-fixture"
import { readJson, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"
import type { SessionUser } from "./payout-booking.integration-fixture"

const { session } = vi.hoisted(() => ({ session: { current: null as null | { user: SessionUser } } }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => session.current) }))

const RUN = process.env.RUN_ASSET_FINANCE_RECOVERY_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
let fx: RecoveryFixture
const database = (): PrismaClient => {
  if (!db) throw new Error("RUN_ASSET_FINANCE_RECOVERY_IT=1 is required")
  return db
}
const routes = () => saleRoutes(fx.host)

const TOWING_CENTS = 500_000

/** A LISTED NCA s131 recovery of a loan with one instalment due on `dueOn` and nothing paid: 5% a month, flat, no service fee. */
async function overdueListed(principal: number, interest: number, dueOn: string) {
  const rec = await ladderRecovery(database(), fx, true, "LISTED", { valuationCents: 1_000_000 })
  await testSetup(database(),
    [`UPDATE "Loan" SET "principal" = $1, "totalInterest" = $2, "totalRepayable" = $3, "outstandingPrincipal" = $1, "interestModel" = 'FLAT', "interestRatePm" = 0.05,
        "monthlyServiceFee" = 0 WHERE "id" = $4`, principal, interest, principal + interest, rec.loan.loanId],
  )
  await database().repaymentSchedule.create({
    data: {
      tenantId: fx.tenantId, loanId: rec.loan.loanId, installmentNo: 1, dueDate: new Date(`${dueOn}T10:00:00+02:00`),
      principalDue: principal, interestDue: interest, feesDue: 0, totalDue: principal + interest,
    },
  })
  await recordDecidedCost(database(), fx, rec.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: TOWING_CENTS })
  const valuationId = (await database().recovery.findUniqueOrThrow({ where: { id: rec.id }, select: { valuationId: true } })).valuationId as string
  return { ...rec, valuationId }
}

/** Sells at `price` and applies the proceeds, as the credit officer. */
async function sellAndApply(rec: { id: string; valuationId: string }, price: number) {
  session.current = { user: { id: fx.officer, email: "officer@recovery-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId } }
  const proposed = await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, price)))
  expect(proposed).toMatchObject({ status: 201, body: { approvalRequired: false } })
  expect((await readJson(await routes().completeSale(rec.id, proposed.body.id as string))).status).toBe(200)
  return readJson(await routes().proceeds(rec.id))
}

suite.sequential("default charges inside the settlement a recovery's proceeds are applied against", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2020-01-01T00:00:00+02:00") } })
  }, 120_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  /*
   * Scenario 1: R9 000.00 principal and R500.00 interest, one instalment due 31 Dec 2024, nothing paid. Default interest is 5% a month
   * on the overdue principal: R450.00 a month, 45 000 cents. Section 103(5) (in duplum) stops everything accruing in a default at the
   * principal unpaid when it began, 900 000 cents, which 20 months of 45 000 reach at the end of August 2026. From September 2026 on the
   * default interest owed is therefore exactly 900 000 cents, whatever the day. Nothing else accrues: no service fee (none on the loan),
   * no section 129 letters.
   *   settlement = 950 000 (contract) + 900 000 (default interest) = 1 850 000
   * Sale at R30 000.00 less R5 000.00 towing deducted:
   *   net = 3 000 000 - 500 000 = 2 500 000;  receipt = min(2 500 000, 1 850 000) = 1 850 000;  surplus = 2 500 000 - 1 850 000 = 650 000
   * The receipt pays default interest first (s126(3)): 900 000 to it, 950 000 to the schedule, and the loan is settled.
   */
  it("scenario 1: an old default is capped at its principal (in duplum), so the settlement is 1 850 000 and the surplus 650 000", async () => {
    const rec = await overdueListed(900_000, 50_000, "2024-12-31")
    const applied = await sellAndApply(rec, 3_000_000)
    expect(applied).toMatchObject({ status: 200, body: { paymentCents: 1_850_000, shortfallCents: 0, surplusCents: 650_000, replay: false } })
    const row = await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })
    expect(row).toMatchObject({
      status: "PROCEEDS_APPLIED", settlementDueCents: 1_850_000, grossProceedsCents: 3_000_000, deductedCostsCents: TOWING_CENTS, chargedCostsCents: 0,
      netProceedsCents: 2_500_000, shortfallCents: 0, surplusCents: 650_000,
    })
    const payment = await database().payment.findUniqueOrThrow({ where: { id: row.proceedsPaymentId as string } })
    expect(payment).toMatchObject({ amount: 1_850_000, defaultInterestAllocated: 900_000 })
    expect(await database().loan.findUniqueOrThrow({ where: { id: rec.loan.loanId } })).toMatchObject({ status: "COMPLETED" })
  }, 180_000)

  /*
   * Scenario 2: R75 516.00 principal (7 551 600 cents, no contractual interest), one instalment due on the last day of the month before last,
   * nothing paid, 5% a month. A month's default interest is 5% x 7 551 600 = 377 580 cents, and 377 580 divides exactly by 28, 29, 30
   * and 31, so a day's is a whole number of cents in every month: 13 485 (28 days), 13 020 (29), 12 586 (30), 12 180 (31).
   * Default interest accrues for each complete day from the day after the due date to yesterday. All of last month is one month's:
   * 377 580. This month it is yesterday's day-of-month less one... that is (day of month - 1) days at 377 580 / days in this month.
   *   e.g. 15 Oct 2026 (due 31 Aug 2026): September 377 580 + 14 days x 12 180 = 170 520 -> 548 100;  settlement 7 551 600 + 548 100 = 8 099 700
   * Sale at R120 000.00 less R5 000.00 towing: net 11 500 000;  receipt = settlement;  surplus = 11 500 000 - settlement.
   */
  it("scenario 2: default interest owed on the day is a month's plus the days of this month so far, and is paid first", async () => {
    const today = sastCalendarDate(new Date())
    const [year, month, dayOfMonth] = today.split("-").map(Number)
    const lastOfPreviousMonth = toDayNumber(`${year}-${String(month).padStart(2, "0")}-01`) - 1
    const lastOfMonthBefore = lastOfPreviousMonth - Number(fromDayNumber(lastOfPreviousMonth).slice(8, 10))
    const daysThisMonth = new Date(Date.UTC(year, month, 0)).getUTCDate()
    const monthly = 377_580
    expect(monthly % daysThisMonth).toBe(0)
    const charges = monthly + (dayOfMonth - 1) * (monthly / daysThisMonth)
    const settlement = 7_551_600 + charges

    const rec = await overdueListed(7_551_600, 0, fromDayNumber(lastOfMonthBefore))
    const applied = await sellAndApply(rec, 12_000_000)
    expect(applied).toMatchObject({ status: 200, body: { paymentCents: settlement, shortfallCents: 0, surplusCents: 11_500_000 - settlement } })
    const row = await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })
    expect(row).toMatchObject({ settlementDueCents: settlement, netProceedsCents: 11_500_000, surplusCents: 11_500_000 - settlement })
    expect(await database().payment.findUniqueOrThrow({ where: { id: row.proceedsPaymentId as string } })).toMatchObject({ amount: settlement, defaultInterestAllocated: charges })
  }, 180_000)
})
