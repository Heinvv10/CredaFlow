/**
 * Slice 4a: a recovery's approved costs charged to the account reach the loan's
 * own ledger as a RECOVERY_COST charge dated the proceeds day, so what the loan
 * says is owed after the proceeds is what the recovery says (its shortfall),
 * to the cent. One NCA and one NON_NCA deal; an NCA deal whose in duplum
 * headroom refuses part of the cost (the refused part stays owed on the
 * recovery only); and a settled loan, which is never re-opened for a cost the
 * surplus did not cover. Real migrated Postgres, real routes, default charges
 * live for the tenant. The charge treatment is UNTESTED against the law.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-charged-costs.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient, type RecoveryCostType } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { loanSettlementFigures } from "@/lib/loan/charges-summary"
import { testSetup } from "./lease-servicing.integration-fixture"
import { advance, recordDecidedCost } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, type RecoveryFixture } from "./recovery.integration-fixture"
import { plainListed, readJson, saleBody, saleRoutes } from "./recovery-sale.integration-fixture"
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
const officer = () => { session.current = { user: { id: fx.officer, email: "officer@recovery-it.test", role: "CREDIT_OFFICER", tenantId: fx.tenantId } } }
const routes = () => saleRoutes(fx.host)

/** What the loan itself says is owed now: the schedule's remainder and every charge, as the settlement figure. */
async function loanOwes(loanId: string): Promise<number> {
  const loan = await database().loan.findUniqueOrThrow({ where: { id: loanId }, include: { repaymentSchedule: { orderBy: { installmentNo: "asc" } } } })
  return (await loanSettlementFigures(database() as never, loan, new Date())).totalToSettle
}

/** A single instalment of `totalDueCents` (all principal), due `dueInDays` from today (negative: overdue), on a FLAT loan with 2% a month default interest. */
async function scheduleLoan(loanId: string, principalCents: number, totalDueCents: number, dueInDays: number): Promise<void> {
  await testSetup(database(),
    [`UPDATE "Loan" SET "interestModel" = 'FLAT', "startDate" = CURRENT_TIMESTAMP - INTERVAL '200 days', "maturityDate" = CURRENT_DATE + ${dueInDays}, "interestRatePm" = 0.02,
        "principal" = $2, "totalInterest" = $3, "totalRepayable" = $4, "outstandingPrincipal" = $2 WHERE "id" = $1`, loanId, principalCents, totalDueCents - principalCents, totalDueCents],
    [`INSERT INTO "RepaymentSchedule" ("id", "tenantId", "loanId", "installmentNo", "dueDate", "principalDue", "interestDue", "feesDue", "totalDue")
        VALUES ($1, $2, $3, 1, CURRENT_DATE + ${dueInDays}, $4, $5, 0, $6)`, `rs_${randomUUID().slice(0, 12)}`, fx.tenantId, loanId, principalCents, totalDueCents - principalCents, totalDueCents],
  )
}

/** Sells a LISTED recovery at `priceCents`, applies the proceeds and (NCA) the final notice, opens the outcome. */
async function sellAndSettle(rec: Awaited<ReturnType<typeof plainListed>>, priceCents: number, nca: boolean) {
  officer()
  const sale = (await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, priceCents)))).body.id as string
  expect((await readJson(await routes().completeSale(rec.id, sale))).status).toBe(200)
  expect((await readJson(await routes().proceeds(rec.id))).status).toBe(200)
  if (nca) await advance(database(), fx, rec.loan, rec.id, "FINAL_NOTICE_ISSUED")
  return readJson(await routes().outcome(rec.id))
}

const charged = (type: RecoveryCostType, grossCents: number, legalStepId?: string) => ({ type, treatment: "CHARGE_TO_ACCOUNT" as const, grossCents, legalStepId })
const judgmentOf = async (recoveryId: string) => {
  const recovery = await database().recovery.findUniqueOrThrow({ where: { id: recoveryId }, select: { legalMatterId: true } })
  return (await database().legalMatterStep.findFirstOrThrow({ where: { matterId: recovery.legalMatterId as string, kind: "JUDGMENT" } })).id
}

suite.sequential("a recovery's charged costs on the loan ledger (real Postgres, real routes)", () => {
  beforeAll(async () => {
    fx = await createRecoveryFixture(database(), t)
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2026-01-01T00:00:00+02:00") } })
  }, 120_000)

  afterAll(async () => {
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("NCA: the loan owes the recovery's shortfall after the proceeds, the cost on its ledger as a RECOVERY_COST", async () => {
    const rec = await plainListed(database(), fx, "NCA", 20_000_000)
    await scheduleLoan(rec.loan.loanId, 150_000_000, 153_000_000, -60)
    await recordDecidedCost(database(), fx, rec.id, charged("LEGAL_TAXED", 2_127_500, await judgmentOf(rec.id)))
    expect(await sellAndSettle(rec, 60_000_000, true)).toMatchObject({ status: 200, body: { status: "SHORTFALL_OPEN" } })

    const recovery = await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })
    expect(recovery).toMatchObject({ chargedCostsCents: 2_127_500, deductedCostsCents: 0 })
    expect(recovery.shortfallCents).toBe(recovery.settlementDueCents! + 2_127_500 - 60_000_000)
    expect(await loanOwes(rec.loan.loanId)).toBe(recovery.shortfallCents)
    const cost = await database().recoveryCost.findFirstOrThrow({ where: { recoveryId: rec.id } })
    expect(await database().loanCharge.findMany({ where: { loanId: rec.loan.loanId, type: "RECOVERY_COST" } })).toMatchObject([{ amount: 2_127_500, sourceId: cost.id }])
    expect(await database().loan.findUniqueOrThrow({ where: { id: rec.loan.loanId } })).toMatchObject({ status: "ACTIVE", collectionsStage: "NONE" })
  }, 180_000)

  it("NON_NCA: REC-NV-1's loan owes its 34 596 789 shortfall after the proceeds", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    await scheduleLoan(rec.loan.loanId, 180_456_789, 180_456_789, 90)
    await recordDecidedCost(database(), fx, rec.id, { type: "TOWING", treatment: "DEDUCT_FROM_PROCEEDS", grossCents: 1_265_000 })
    await recordDecidedCost(database(), fx, rec.id, charged("LEGAL_CONTRACTUAL", 2_875_000))
    expect(await sellAndSettle(rec, 150_000_000, false)).toMatchObject({ status: 200, body: { status: "SHORTFALL_OPEN" } })

    const recovery = await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })
    expect(recovery).toMatchObject({ settlementDueCents: 180_456_789, netProceedsCents: 148_735_000, shortfallCents: 34_596_789 })
    expect(await loanOwes(rec.loan.loanId)).toBe(34_596_789)
    expect(await database().loanCharge.findMany({ where: { loanId: rec.loan.loanId, type: "RECOVERY_COST" } })).toMatchObject([{ amount: 2_875_000 }])
    // Frozen charges stay frozen, the cost is not: the figure holds through the demand period.
    const loan = await database().loan.findUniqueOrThrow({ where: { id: rec.loan.loanId } })
    expect(loan).toMatchObject({ status: "ACTIVE", chargesOutstanding: 2_875_000 })
  }, 180_000)

  it("NCA, in duplum: the part of a cost the headroom refuses stays owed on the recovery only", async () => {
    const rec = await plainListed(database(), fx, "NCA", 2_000_000)
    // R100 000 owed, 60 days overdue: the cap is that principal, less what is reserved and accrued.
    await scheduleLoan(rec.loan.loanId, 10_000_000, 10_200_000, -60)
    await recordDecidedCost(database(), fx, rec.id, charged("LEGAL_TAXED", 12_000_000, await judgmentOf(rec.id)))
    expect(await sellAndSettle(rec, 5_000_000, true)).toMatchObject({ status: 200, body: { status: "SHORTFALL_OPEN" } })

    const recovery = await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })
    expect(recovery.chargedCostsCents).toBe(12_000_000)
    expect(recovery.shortfallCents).toBe(recovery.settlementDueCents! + 12_000_000 - 5_000_000)
    const [posted] = await database().loanCharge.findMany({ where: { loanId: rec.loan.loanId, type: "RECOVERY_COST" } })
    expect(posted.amount).toBeGreaterThan(0)
    expect(posted.amount).toBeLessThan(12_000_000)
    const refused = 12_000_000 - posted.amount
    expect(await loanOwes(rec.loan.loanId)).toBe(recovery.shortfallCents! - refused)
    // The instalment is past due, so nothing is reserved: interest and the cost together fill the principal at default (R100 000) and stop there.
    const interest = await database().loanCharge.aggregate({ where: { loanId: rec.loan.loanId, type: "DEFAULT_INTEREST" }, _sum: { amount: true } })
    const filled = (interest._sum.amount ?? 0) + posted.amount
    expect(filled).toBeLessThanOrEqual(10_000_000)
    expect(filled).toBeGreaterThan(9_999_000)
  }, 180_000)

  it("never re-opens a loan the proceeds settled: a cost the surplus did not cover stays owed on the recovery", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    await scheduleLoan(rec.loan.loanId, 100_000_000, 100_000_000, 30)
    await recordDecidedCost(database(), fx, rec.id, charged("LEGAL_CONTRACTUAL", 3_000_000))
    // A price R10,000 over the settlement against R30,000 of charged costs: R20,000 uncovered.
    expect(await sellAndSettle(rec, 101_000_000, false)).toMatchObject({ status: 200, body: { status: "SHORTFALL_OPEN" } })
    expect(await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).toMatchObject({ surplusCents: 0, shortfallCents: 2_000_000 })
    expect(await database().loanCharge.count({ where: { loanId: rec.loan.loanId, type: "RECOVERY_COST" } })).toBe(0)
    expect(await database().loan.findUniqueOrThrow({ where: { id: rec.loan.loanId } })).toMatchObject({ status: "COMPLETED", chargesOutstanding: 0 })
    expect(await loanOwes(rec.loan.loanId)).toBe(0)
  }, 180_000)
})
