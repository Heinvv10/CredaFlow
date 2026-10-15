/**
 * BREAK TEST 4 (RUN_ASSET_FINANCE_RECOVERY_IT): unfreezing charges early or shortening the post-sale charge freeze.
 * A red case is a reproduced FAIL.
 */
import { randomUUID } from "node:crypto"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { loadChargesReplay } from "@/lib/loan/charges-replay"
import { GET as deadlineCron } from "@/app/api/cron/asset-finance-recovery-deadlines/route"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { testSetup } from "./lease-servicing.integration-fixture"
import { advance } from "./recovery-path.integration-fixture"
import { cleanupE2e } from "./recovery-e2e.integration-fixture"
import { cleanupRecoveryFixture, day, newLoan, newRecovery, today, type RecoveryFixture } from "./recovery.integration-fixture"
import { disburseApplication, plainListed, readJson, saleBody } from "./recovery-sale.integration-fixture"
import { asUser, bundle, db, makeTenant, RUN, sessionBox } from "./recovery-break.fixture"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => sessionBox.current) }))

const suite = RUN ? describe : describe.skip
let fx: RecoveryFixture
const officer = () => asUser(fx, fx.officer, "CREDIT_OFFICER")
const R = () => bundle(fx)
const noon = (iso: string) => new Date(`${iso}T12:00:00+02:00`)
const plus = (iso: string, days: number) => fromDayNumber(toDayNumber(iso) + days)
const CRON_SECRET = "break-it-cron"

async function interestAt(loanId: string, asOf: string): Promise<number> {
  const replay = await loadChargesReplay(db as never, { tenantId: fx.tenantId, loanId }, noon(asOf))
  return replay!.result.interestAccrued
}
async function overdueInstalment(loanId: string): Promise<void> {
  await testSetup(db, [`UPDATE "Loan" SET "nonNcaDefaultInterestMargin" = 0.05 WHERE "id" = $1 AND "ncaRegime" = 'NON_NCA'`, loanId],
    [`UPDATE "Loan" SET "startDate" = CURRENT_TIMESTAMP - INTERVAL '120 days', "maturityDate" = CURRENT_TIMESTAMP - INTERVAL '60 days', "interestRatePm" = 0.02,
        "totalInterest" = 3000000, "totalRepayable" = 153000000 WHERE "id" = $1`, loanId],
    [`INSERT INTO "RepaymentSchedule" ("id", "tenantId", "loanId", "installmentNo", "dueDate", "principalDue", "interestDue", "feesDue", "totalDue")
        VALUES ($1, $2, $3, 1, CURRENT_DATE - 60, 150000000, 3000000, 0, 153000000)`, `rs_${randomUUID().slice(0, 12)}`, fx.tenantId, loanId],
  )
}

/** A recovery recovered `daysAgo` days ago, taken to LISTED. */
async function oldListed(regime: "NCA" | "NON_NCA", daysAgo: number) {
  const loan = await newLoan(db, fx, regime)
  const extra: Record<string, unknown> = { recoveredOn: dbDate(day(-daysAgo)) }
  if (regime === "NCA") {
    // an s131 recovery needs a matter with judgment + attachment order
    const { newMatter, addStep } = await import("./recovery.integration-fixture")
    const matter = await newMatter(db, fx, loan.loanId)
    await addStep(db, fx, matter, "JUDGMENT", day(-daysAgo - 1))
    await addStep(db, fx, matter, "ATTACHMENT_ORDER", day(-daysAgo - 1))
    extra.legalMatterId = matter
  }
  const id = await newRecovery(db, fx, loan, regime === "NCA" ? "NCA_S131_ATTACHMENT" : "NON_NCA_VOLUNTARY", extra)
  await advance(db, fx, loan, id, "LISTED", { valuationCents: 100_000_000 })
  await disburseApplication(db, fx, loan)
  await testSetup(db,
    [`UPDATE "Loan" SET "startDate" = CURRENT_TIMESTAMP - INTERVAL '90 days' WHERE "id" = $1`, loan.loanId],
    [`UPDATE "LoanApplication" SET "disbursedAt" = CURRENT_TIMESTAMP - INTERVAL '90 days' WHERE "id" = (SELECT "applicationId" FROM "Loan" WHERE "id" = $1)`, loan.loanId])
  const valuationId = (await db.recovery.findUniqueOrThrow({ where: { id } })).valuationId as string
  return { loan, id, valuationId }
}

suite.sequential("break 4: charge freeze", () => {
  beforeAll(async () => {
    process.env.TRUSTED_PROXY = "1"; process.env.CRON_SECRET = CRON_SECRET
    fx = await makeTenant()
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2026-01-01T00:00:00+02:00") } })
  }, 120_000)
  afterAll(async () => {
    sessionBox.current = null
    await cleanupE2e(db, fx.tenantId).catch(() => undefined)
    await cleanupRecoveryFixture(db, fx.tenantId).catch(() => undefined)
    await db.$disconnect()
  }, 120_000)

  it("4a. NON_NCA: back-dating receivedAt must not shorten the freeze or leave a stray Payment (refused and rolled back)", async () => {
    const rec = await oldListed("NON_NCA", 30)
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    expect((await readJson(await R().s.completeSale(rec.id, sale))).status).toBe(200)
    const out = await readJson(await R().s.proceeds(rec.id, { receivedAt: noon(day(-29)).toISOString() }))
    const row = await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })
    if (out.status === 200) {
      const until = row.chargesFrozenUntil!.toISOString().slice(0, 10)
      expect(until >= today(), `freeze ended ${until}, before today ${today()}: backdated receivedAt shortened it`).toBe(true)
    } else {
      expect(row.status).toBe("SOLD")
      expect(await db.payment.count({ where: { loanId: rec.loan.loanId } }), "a Payment survived the refused proceeds").toBe(0)
    }
  }, 120_000)

  it("4b. NON_NCA: charges do not accrue on the days of a (correctly dated) freeze, and do after", async () => {
    const rec = await oldListed("NON_NCA", 0)
    await overdueInstalment(rec.loan.loanId)
    const T = today()
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    expect((await readJson(await R().s.proceeds(rec.id))).status).toBe(200)
    const row = await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })
    const until = row.chargesFrozenUntil!.toISOString().slice(0, 10)
    expect(until).toBe(plus(T, 10))
    const frozen = await interestAt(rec.loan.loanId, T)
    for (const d of [1, 5, 10]) expect(await interestAt(rec.loan.loanId, plus(T, d)), `day +${d}`).toBe(frozen)
    expect(await interestAt(rec.loan.loanId, plus(until, 3))).toBeGreaterThan(frozen)
  }, 120_000)

  it("4c. NCA: back-dated receivedAt cannot shorten the freeze; refused and rolled back (no stray Payment)", async () => {
    const rec = await oldListed("NCA", 30)
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    const out = await readJson(await R().s.proceeds(rec.id, { receivedAt: noon(day(-29)).toISOString() }))
    const row = await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })
    if (out.status === 200) {
      expect((await R().r.finalNotice(rec.id)).status).toBe(200)
      expect((await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })).chargesFrozenUntil!.toISOString().slice(0, 10)).toBe(addSouthAfricanBusinessDays(today(), 10))
    } else {
      expect(row.status).toBe("SOLD")
      expect(await db.payment.count({ where: { loanId: rec.loan.loanId } })).toBe(0)
    }
  }, 120_000)

  it("4d. freeze dates are write-once (direct DB edits to shorten or clear them are refused)", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    await R().s.proceeds(rec.id)
    await expect(db.recovery.update({ where: { id: rec.id }, data: { chargesFrozenUntil: dbDate(day(-1)) } })).rejects.toThrow()
    await expect(db.recovery.update({ where: { id: rec.id }, data: { chargesFrozenUntil: null } })).rejects.toThrow()
    await expect(db.recovery.update({ where: { id: rec.id }, data: { chargesFrozenFrom: dbDate(day(1)) } })).rejects.toThrow()
    await expect(db.recovery.update({ where: { id: rec.id }, data: { chargesFrozenFrom: null, chargesFrozenUntil: null } })).rejects.toThrow()
  }, 120_000)

  it("4e. proceeds are applied as of now: any receivedAt (past, future, garbage) is refused with 400 and the stored freeze never moves", async () => {
    const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    for (const receivedAt of [noon(day(3)).toISOString(), noon(day(-2)).toISOString(), "garbage"]) {
      expect((await readJson(await R().s.proceeds(rec.id, { receivedAt }))).status, receivedAt).toBe(400)
    }
    expect(await db.payment.count({ where: { loanId: rec.loan.loanId } })).toBe(0)
    await R().s.proceeds(rec.id)
    const before = (await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })).chargesFrozenUntil
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { nonNcaDemandPeriodDays: 1 } })
    await R().s.proceeds(rec.id)
    const after = (await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })).chargesFrozenUntil
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { nonNcaDemandPeriodDays: 10 } })
    expect(after).toEqual(before)
  }, 120_000)

  it("4f. NON_NCA: a demand period of 1 day configured BEFORE the proceeds shortens the freeze (who can set it?)", async () => {
    await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { nonNcaDemandPeriodDays: 1 } })
    try {
      const rec = await plainListed(db, fx, "NON_NCA", 100_000_000)
      officer()
      const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
      await R().s.completeSale(rec.id, sale)
      await R().s.proceeds(rec.id)
      const row = await db.recovery.findUniqueOrThrow({ where: { id: rec.id } })
      // a 1-day demand period is inside the CHECK (1..90): note the freeze it produces
      expect(row.chargesFrozenUntil!.toISOString().slice(0, 10)).toBe(plus(today(), 1))
    } finally {
      await db.tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { nonNcaDemandPeriodDays: 10 } })
    }
  }, 120_000)

  it("4g. the deadline cron cannot be run early (query/header day overrides ignored, wrong secret refused)", async () => {
    const { loan, id } = await (async () => {
      const rec = await plainListed(db, fx, "NCA", 100_000_000)
      officer()
      const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
      await R().s.completeSale(rec.id, sale)
      await R().s.proceeds(rec.id)
      await R().r.finalNotice(rec.id)
      await R().s.outcome(rec.id)
      return { loan: rec.loan, id: rec.id }
    })()
    const hit = async (url: string, headers: Record<string, string>) => readJson(await deadlineCron(new NextRequest(url, { headers })))
    expect((await hit("http://localhost/api/cron/asset-finance-recovery-deadlines", { "x-cron-secret": "wrong" })).status).toBe(401)
    const early = await hit(`http://localhost/api/cron/asset-finance-recovery-deadlines?day=2099-01-01&asOf=2099-01-01`, { "x-cron-secret": CRON_SECRET, "x-day": "2099-01-01" })
    expect(early.status).toBe(200)
    const handled = await db.auditLog.count({ where: { tenantId: fx.tenantId, action: "ASSET_RECOVERY_DEADLINE_PASSED", entityId: id } })
    expect(handled, "the sweep handled a recovery still inside its freeze").toBe(0)
    expect((await db.recovery.findUniqueOrThrow({ where: { id } })).status).toBe("SHORTFALL_OPEN")
    expect(loan.loanId).toBeTruthy()
  }, 120_000)

  it("4h. NCA: interest does not accrue between proceeds and final notice, and a replay at several asOf dates agrees", async () => {
    const rec = await plainListed(db, fx, "NCA", 100_000_000)
    await overdueInstalment(rec.loan.loanId)
    const T = today()
    officer()
    const sale = (await readJson(await R().s.propose(rec.id, saleBody(rec.valuationId, 100_000_000)))).body.id as string
    await R().s.completeSale(rec.id, sale)
    await R().s.proceeds(rec.id)
    const base = await interestAt(rec.loan.loanId, T)
    for (const d of [1, 2, 30, 400]) expect(await interestAt(rec.loan.loanId, plus(T, d)), `open-ended freeze, +${d}`).toBe(base)
    // a past asOf (before the freeze) is unaffected by the freeze
    expect(await interestAt(rec.loan.loanId, plus(T, -3))).toBeLessThanOrEqual(base)
  }, 120_000)
})
