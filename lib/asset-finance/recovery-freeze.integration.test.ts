/**
 * Slice 4a charge freeze, outcome and deadline sweep (real migrated Postgres):
 * once sale proceeds are applied, an overdue NCA loan accrues no default
 * interest from the proceeds date through the final notice's deadline (the
 * replay and the nightly sweep both honour it), accrues again the day after
 * with the NCA cap still binding; the outcome opens as SHORTFALL_OPEN,
 * SURPLUS_HELD or CLOSED; and the daily deadline cron, once per recovery, moves
 * an attorney-referred loan forward in collections (never back, never to
 * write-off), bells the recovery's creator and audits it. The freeze and the
 * hand-over are UNTESTED against the law: these prove the rules as written.
 *
 *   RUN_ASSET_FINANCE_RECOVERY_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/recovery-freeze.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { addSouthAfricanBusinessDays } from "@/lib/compliance/sa-business-days"
import { loadChargesReplay } from "@/lib/loan/charges-replay"
import { sweepTenantCharges } from "@/lib/loan/charges-sweep"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { GET as deadlineCron } from "@/app/api/cron/asset-finance-recovery-deadlines/route"
import { dbDate, fromDayNumber, toDayNumber } from "./dates"
import { testSetup } from "./lease-servicing.integration-fixture"
import { advance, ladderRecovery } from "./recovery-path.integration-fixture"
import { cleanupRecoveryFixture, createRecoveryFixture, recoveryFixtureTenantId, today, type RecoveryFixture } from "./recovery.integration-fixture"
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
const noon = (iso: string) => new Date(`${iso}T12:00:00+02:00`)
const plus = (iso: string, days: number) => fromDayNumber(toDayNumber(iso) + days)
const CRON_SECRET = "recovery-it-cron-secret"

/** Default interest accrued on the loan as at `asOf`, from the real replay (which reads the loan's recovery freeze). */
async function interestAt(loanId: string, asOf: string): Promise<number> {
  const replay = await loadChargesReplay(database() as never, { tenantId: fx.tenantId, loanId }, noon(asOf))
  return replay!.result.interestAccrued
}

suite.sequential("charge freeze, outcome and deadline sweep (real Postgres)", () => {
  beforeAll(async () => {
    process.env.CRON_SECRET = CRON_SECRET
    fx = await createRecoveryFixture(database(), t)
    await database().vatConfig.create({ data: { tenantId: fx.tenantId, vatNumber: "4000000001", registeredName: "TEST Asset Credit (Pty) Ltd", address: "1 Synthetic Road, Johannesburg, 2000" } })
    await database().tenantConfig.update({ where: { tenantId: fx.tenantId }, data: { defaultChargesEnabled: true, defaultChargesStartedAt: new Date("2026-01-01T00:00:00+02:00") } })
  }, 120_000)

  afterAll(async () => {
    vi.useRealTimers()
    await cleanupRecoveryFixture(database(), recoveryFixtureTenantId(t)).catch(() => undefined)
    await db?.$disconnect()
  }, 60_000)

  it("accrues no default interest from the proceeds date through the deadline, then accrues again under the NCA cap", async () => {
    const rec = await plainListed(database(), fx, "NCA", 20_000_000)
    const { loanId } = rec.loan
    // An instalment 60 days overdue, so default interest runs daily.
    await testSetup(database(),
      [`UPDATE "Loan" SET "startDate" = CURRENT_TIMESTAMP - INTERVAL '120 days', "maturityDate" = CURRENT_TIMESTAMP - INTERVAL '60 days', "interestRatePm" = 0.02,
          "totalInterest" = 3000000, "totalRepayable" = 153000000 WHERE "id" = $1`, loanId],
      [`INSERT INTO "RepaymentSchedule" ("id", "tenantId", "loanId", "installmentNo", "dueDate", "principalDue", "interestDue", "feesDue", "totalDue")
          VALUES ($1, $2, $3, 1, CURRENT_DATE - 60, 150000000, 3000000, 0, 153000000)`, `rs_${randomUUID().slice(0, 12)}`, fx.tenantId, loanId],
    )
    const T = today()
    const beforeSale = await interestAt(loanId, T)
    expect(beforeSale).toBeGreaterThan(0)
    expect(await interestAt(loanId, plus(T, 1))).toBeGreaterThan(beforeSale) // accruing, as nothing is frozen yet

    officer()
    const sale = (await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, 60_000_000)))).body.id as string
    expect((await readJson(await routes().completeSale(rec.id, sale))).status).toBe(200)
    expect((await readJson(await routes().proceeds(rec.id))).status).toBe(200)

    // Frozen from the proceeds date; before the final notice fixes the end it is open-ended.
    const frozenAt = await interestAt(loanId, T)
    for (const days of [1, 5, 40]) expect(await interestAt(loanId, plus(T, days))).toBe(frozenAt)

    await advance(database(), fx, rec.loan, rec.id, "FINAL_NOTICE_ISSUED")
    const until = addSouthAfricanBusinessDays(T, 10)
    expect((await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).chargesFrozenUntil?.toISOString().slice(0, 10)).toBe(until)
    expect(await interestAt(loanId, until)).toBe(frozenAt) // the deadline day itself is frozen
    expect(await interestAt(loanId, plus(until, 1))).toBe(frozenAt) // asOf is exclusive: the day after is the first to accrue
    const first = await interestAt(loanId, plus(until, 2))
    const second = await interestAt(loanId, plus(until, 3))
    expect(first).toBeGreaterThan(frozenAt)
    expect(second - first).toBeGreaterThan(0)
    // The NCA cap (in duplum) still binds once accrual resumes: far out, interest stops at the cap.
    const far = await interestAt(loanId, plus(until, 5_000))
    const farther = await interestAt(loanId, plus(until, 10_000))
    expect(far).toBeGreaterThan(second)
    expect(farther).toBe(far)

    // The nightly sweep derives the same through the same replay: nothing posts during the freeze, interest posts after it.
    const sweep = (asOf: string) => runWithTenant(fx.tenantId, () => sweepTenantCharges(prisma, fx.tenantId, noon(asOf), { source: "cron:default-charges" }))
    expect(await sweep(plus(T, 3))).toMatchObject({ failures: [] })
    const duringFreeze = (await database().loan.findUniqueOrThrow({ where: { id: loanId } })).chargesAccrued
    expect(await sweep(until)).toMatchObject({ failures: [] })
    expect((await database().loan.findUniqueOrThrow({ where: { id: loanId } })).chargesAccrued).toBe(duringFreeze)
    expect(await sweep(plus(until, 3))).toMatchObject({ failures: [] })
    expect((await database().loan.findUniqueOrThrow({ where: { id: loanId } })).chargesAccrued).toBeGreaterThan(duringFreeze)

    officer()
    expect(await readJson(await routes().outcome(rec.id))).toMatchObject({ status: 200, body: { status: "SHORTFALL_OPEN" } })
    // Write-off is a human decision: nothing here touches the loan's status or stage.
    expect(await database().loan.findUniqueOrThrow({ where: { id: loanId } })).toMatchObject({ status: "ACTIVE", collectionsStage: "NONE" })
  }, 240_000)

  it("closes a recovery straight away when the proceeds settle the loan exactly", async () => {
    const rec = await plainListed(database(), fx, "NON_NCA", 100_000_000)
    officer()
    const sale = (await readJson(await routes().propose(rec.id, saleBody(rec.valuationId, 150_000_001)))).body.id as string
    expect((await readJson(await routes().completeSale(rec.id, sale))).status).toBe(200)
    expect(await readJson(await routes().proceeds(rec.id))).toMatchObject({ status: 200, body: { paymentCents: 150_000_001, shortfallCents: 0, surplusCents: 0 } })
    expect(await readJson(await routes().outcome(rec.id))).toMatchObject({ status: 200, body: { status: "CLOSED" } })
    expect(await database().recovery.findUniqueOrThrow({ where: { id: rec.id } })).toMatchObject({ status: "CLOSED" })
    expect((await readJson(await routes().outcome(rec.id))).status).toBe(409)
    expect(await database().payment.count({ where: { loanId: rec.loan.loanId } })).toBe(1)
  }, 120_000)

  it("hands a shortfall loan on once, after the deadline: forward only, never to write-off, one bell item and one audit row each", async () => {
    const open = async (stage: "NONE" | "SOFT_REMINDER" | "WRITTEN_OFF", attorney: boolean) => {
      const { loan, id } = await ladderRecovery(database(), fx, true, "SHORTFALL_OPEN")
      await testSetup(database(), [`UPDATE "Loan" SET "collectionsStage" = $1::"CollectionsStage" WHERE "id" = $2`, stage, loan.loanId])
      const row = await database().recovery.findUniqueOrThrow({ where: { id } })
      if (attorney) await database().legalMatter.update({ where: { id: row.legalMatterId as string }, data: { attorneySupplierId: fx.attorney, attorneyAppointedOn: dbDate(today()) } })
      return { loanId: loan.loanId, id, until: row.chargesFrozenUntil!.toISOString().slice(0, 10) }
    }
    const referred = await open("NONE", true)
    const noAttorney = await open("SOFT_REMINDER", false)
    const writtenOff = await open("WRITTEN_OFF", true)
    const run = async (day: string) => {
      vi.useFakeTimers({ toFake: ["Date"], now: noon(day) })
      try {
        return await readJson(await deadlineCron(new NextRequest("http://localhost/api/cron/asset-finance-recovery-deadlines", { headers: { "x-cron-secret": CRON_SECRET } })))
      } finally {
        vi.useRealTimers()
      }
    }
    const stage = async (loanId: string) => (await database().loan.findUniqueOrThrow({ where: { id: loanId } })).collectionsStage
    const bells = (id: string) => database().notification.findMany({ where: { tenantId: fx.tenantId, type: "RECOVERY_DEADLINE_PASSED", entityId: id } })
    const audits = (id: string) => database().auditLog.count({ where: { tenantId: fx.tenantId, action: "ASSET_RECOVERY_DEADLINE_PASSED", entityId: id } })

    expect(await readJson(await deadlineCron(new NextRequest("http://localhost/x")))).toMatchObject({ status: 401 })
    // On the deadline day the freeze is still running.
    expect((await run(referred.until)).body).toMatchObject({ ok: true, handled: 0 })
    expect(await bells(referred.id)).toHaveLength(0)

    const first = await run(plus(referred.until, 1))
    expect(first).toMatchObject({ status: 200, body: { ok: true, failed: 0 } })
    expect(first.body.handled).toBeGreaterThanOrEqual(3)
    expect(await stage(referred.loanId)).toBe("ATTORNEY_REFERRED")
    expect(await stage(noAttorney.loanId)).toBe("SOFT_REMINDER")
    expect(await stage(writtenOff.loanId)).toBe("WRITTEN_OFF")
    for (const rec of [referred, noAttorney, writtenOff]) {
      const items = await bells(rec.id)
      expect(items).toHaveLength(1)
      expect(items[0]).toMatchObject({ userId: fx.officer, entityType: "Recovery" })
      expect(`${items[0].title} ${items[0].body}`).not.toMatch(/TEST|Debtor/)
      expect(await audits(rec.id)).toBe(1)
    }

    const again = await run(plus(referred.until, 2))
    expect(again.body).toMatchObject({ ok: true, handled: 0 })
    for (const rec of [referred, noAttorney, writtenOff]) {
      expect(await bells(rec.id)).toHaveLength(1)
      expect(await audits(rec.id)).toBe(1)
      expect((await database().loan.findUniqueOrThrow({ where: { id: rec.loanId } })).status).toBe("ACTIVE")
    }
  }, 240_000)
})
