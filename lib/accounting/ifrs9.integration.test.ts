/**
 * Real-Postgres proof that the IFRS 9 provision and interest in suspense reach the ledger through the real close:
 * a month closes only against its monthly staging run, the allowance and the suspense follow the run month by month, a
 * write-off turns the suspended interest into a smaller bad debt, a lender without IFRS 9 posts nothing of it, and the
 * borrower's receivable (the reconciliation control) never moves.
 *
 *   RUN_IFRS9_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/accounting/ifrs9.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { DEFAULT_SETTINGS } from "@/lib/ifrs9/types"
import { executeRun } from "@/lib/ifrs9/run"
import { replaceParameters, saveSettings } from "@/lib/ifrs9/store"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { ASSET_FINANCE_ROLES, IFRS9_ROLES } from "./accounts"
import { closePeriod } from "./generate"
import { parsePeriodKey } from "./period"
import { planPeriod } from "./plan"

const suite = process.env.RUN_IFRS9_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const NOW = new Date("2027-01-05T10:00:00+02:00")
const at = (iso: string) => new Date(`${iso}+02:00`)

async function lender(ifrs9: boolean): Promise<ChargesTenant & { loanId: string }> {
  const tenant = await createChargesTenant(db, false)
  const loan = await createChargesLoan(db, tenant)
  await db.accountingSettings.create({
    data: { tenantId: tenant.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08", mappingConfirmedRoles: [...ASSET_FINANCE_ROLES, ...IFRS9_ROLES] },
  })
  if (ifrs9) {
    const actor = { id: tenant.userId, email: "ifrs9-it@test.invalid" }
    await runWithTenant(tenant.tenantId, async () => {
      await saveSettings(prisma, tenant.tenantId, { ...DEFAULT_SETTINGS, enabled: true, effectiveFromMonth: "2026-10" }, actor)
      await replaceParameters(prisma, tenant.tenantId, [
        { scopeKey: "DEFAULT", stage: 1, pdBps: 200, lgdBps: 4500 },
        { scopeKey: "DEFAULT", stage: 2, pdBps: 1500, lgdBps: 5000 },
        { scopeKey: "DEFAULT", stage: 3, pdBps: 10_000, lgdBps: 6000 },
      ], actor)
    })
  }
  return { ...tenant, loanId: loan.loanId }
}

const plan = (t: ChargesTenant, key: string) => runWithTenant(t.tenantId, () => planPeriod(prisma, t.tenantId, parsePeriodKey(key)!, NOW))
const close = (t: ChargesTenant, key: string) =>
  runWithTenant(t.tenantId, () => closePeriod(prisma, { tenantId: t.tenantId, periodKey: key, userId: t.userId, userEmail: "ifrs9-it@test.invalid", now: NOW }))
const monthly = (t: ChargesTenant, periodKey: string, iso: string, extra: { supersede?: { runId: string; reason: string }; lateReason?: string } = {}) =>
  runWithTenant(t.tenantId, () => executeRun(t.tenantId, { kind: "MONTHLY", periodKey, now: at(iso), ...extra }))

/** Σ(debit - credit) per role over every closed batch of the tenant. */
async function totals(tenantId: string): Promise<Record<string, number>> {
  const rows = await db.$queryRaw<Array<{ role: string; cents: bigint }>>`
    SELECT COALESCE(l."sourceRole", l."role") AS role, SUM(l."debitCents" - l."creditCents")::bigint AS cents
    FROM "AccountingJournalLine" l JOIN "AccountingExportBatch" b ON b."id" = l."batchId"
    WHERE l."tenantId" = ${tenantId} AND b."status" = 'CLOSED' AND l."role" <> 'OPENING_BALANCE_EQUITY' GROUP BY 1`
  return Object.fromEntries(rows.map((r) => [r.role, Number(r.cents)]))
}
const ifrs9Of = (t: Record<string, number>) => ({ ECL_ALLOWANCE: t.ECL_ALLOWANCE ?? 0, ECL_EXPENSE: t.ECL_EXPENSE ?? 0, INTEREST_SUSPENSE: t.INTEREST_SUSPENSE ?? 0 })

let a: Awaited<ReturnType<typeof lender>>
let plain: Awaited<ReturnType<typeof lender>>

suite.sequential("IFRS 9 in the ledger (real Postgres)", () => {
  beforeAll(async () => {
    ;[a, plain] = [await lender(true), await lender(false)]
  })
  afterAll(async () => {
    await db.$disconnect()
    await prisma.$disconnect()
  })

  it("does not ask for a run before the month IFRS 9 takes effect, and closes August and September as before", async () => {
    for (const key of ["2026-08", "2026-09"]) {
      expect((await plan(a, key)).refusal).toBeNull()
      await close(a, key)
    }
    expect(ifrs9Of(await totals(a.tenantId))).toEqual({ ECL_ALLOWANCE: 0, ECL_EXPENSE: 0, INTEREST_SUSPENSE: 0 })
  })

  it("refuses October until its monthly run exists, then posts the allowance: 60 days past due is Stage 2", async () => {
    const refused = await plan(a, "2026-10")
    expect(refused.refusal).toMatchObject({ code: "IFRS9_RUN_MISSING" })
    await expect(close(a, "2026-10")).rejects.toMatchObject({ code: "IFRS9_RUN_MISSING" })

    await monthly(a, "2026-10", "2026-10-31T23:50:00")
    const ready = await plan(a, "2026-10")
    expect(ready.refusal).toBeNull()
    // The borrower's receivable is untouched: the reconciliation control still ties.
    expect(ready.reconciliation.mismatches).toEqual([])
    await close(a, "2026-10")
    // EAD 216 900 (R2 000 principal + R100 interest + R69 fees), ECL = 216 900 x 15% x 50% = 16 267.5 -> 16 268
    expect(ifrs9Of(await totals(a.tenantId))).toEqual({ ECL_ALLOWANCE: -16_268, ECL_EXPENSE: 16_268, INTEREST_SUSPENSE: 0 })
  })

  it("at 90 days past due moves to Stage 3: the allowance grows by the movement and the instalment's interest leaves income for suspense", async () => {
    await monthly(a, "2026-11", "2026-11-30T23:50:00")
    await close(a, "2026-11")
    const t = await totals(a.tenantId)
    // EAD 200 000 + 10 000 + 6 900 - 10 000 suspended = 206 900; ECL = 206 900 x 100% x 60% = 124 140
    expect(ifrs9Of(t)).toEqual({ ECL_ALLOWANCE: -124_140, ECL_EXPENSE: 124_140, INTEREST_SUSPENSE: -10_000 })
    // R100.00 of interest income recognised when the instalment fell due is now held back: income nets to nil
    expect(t.INTEREST_INCOME).toBe(0)
    // the receivable still holds everything owed
    expect(t.LOAN_BOOK).toBe(216_900)
  })

  it("on write-off uses the allowance against the bad debt and takes the suspended interest off it, not into income", async () => {
    await db.loan.update({ where: { id: a.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: at("2026-12-15T10:00:00"), closedAt: at("2026-12-15T10:00:00") } })
    const run = await monthly(a, "2026-12", "2026-12-31T23:50:00")
    expect(run.loanCount, "a written-off loan is not on the collectible book").toBe(0)
    expect((await plan(a, "2026-12")).refusal).toBeNull()
    await close(a, "2026-12")
    const t = await totals(a.tenantId)
    // the allowance (R1 241.40) is used, not released: it stays charged as ECL_EXPENSE and the allowance falls to nil
    expect(ifrs9Of(t)).toEqual({ ECL_ALLOWANCE: 0, ECL_EXPENSE: 124_140, INTEREST_SUSPENSE: 0 })
    // the write-off takes the whole R2 169 off the book; R100.00 of it was never income and R1 241.40 was provided, so the
    // bad debt is R827.60 and the whole loss, provision plus bad debt, is the R2 069 actually lost
    expect(t.LOAN_BOOK).toBe(0)
    expect(t.BAD_DEBT_EXPENSE).toBe(82_760)
    expect(t.ECL_EXPENSE + t.BAD_DEBT_EXPENSE).toBe(206_900)
    expect(t.INTEREST_INCOME).toBe(0)
  })

  it("posts nothing of IFRS 9 for a lender that has not switched it on", async () => {
    for (const key of ["2026-08", "2026-09", "2026-10"]) {
      const p = await plan(plain, key)
      expect(p.refusal, key).toBeNull()
      expect(p.entries.flatMap((e) => e.lines.map((l) => l.role)).filter((r) => (IFRS9_ROLES as readonly string[]).includes(r))).toEqual([])
      await close(plain, key)
    }
    expect(ifrs9Of(await totals(plain.tenantId))).toEqual({ ECL_ALLOWANCE: 0, ECL_EXPENSE: 0, INTEREST_SUSPENSE: 0 })
    expect(await db.ifrs9Run.count({ where: { tenantId: plain.tenantId } })).toBe(0)
  })

  it("closes October on a late run, as October's position, and on a superseding run until the month is closed", async () => {
    const g = await lender(true)
    for (const key of ["2026-08", "2026-09"]) await close(g, key)
    // the month-end job missed 31 Oct: an administrator adds the run on 5 Jan; it is October's, dated 31 Oct
    const late = await monthly(g, "2026-10", "2027-01-05T09:00:00", { lateReason: "the month-end job was down" })
    expect(late).toMatchObject({ late: true, runDate: "2026-10-31" })
    // replace it before closing (R2 169 at 15% PD and 50% LGD is the Stage 2 provision; a corrected 20% PD moves it)
    await runWithTenant(g.tenantId, () => replaceParameters(prisma, g.tenantId, [
      { scopeKey: "DEFAULT", stage: 1, pdBps: 200, lgdBps: 4500 },
      { scopeKey: "DEFAULT", stage: 2, pdBps: 2000, lgdBps: 5000 },
      { scopeKey: "DEFAULT", stage: 3, pdBps: 10_000, lgdBps: 6000 },
    ], { id: g.userId, email: "ifrs9-it@test.invalid" }))
    const fixed = await monthly(g, "2026-10", "2027-01-05T10:00:00", { supersede: { runId: late.runId, reason: "Stage 2 PD corrected" } })
    expect((await plan(g, "2026-10")).refusal).toBeNull()
    await close(g, "2026-10")
    // 216 900 x 20% x 50% = 21 690 : the superseding run, not the one it replaced
    expect(ifrs9Of(await totals(g.tenantId))).toEqual({ ECL_ALLOWANCE: -21_690, ECL_EXPENSE: 21_690, INTEREST_SUSPENSE: 0 })
    const posted = await db.accountingLedgerEntry.findFirstOrThrow({ where: { tenantId: g.tenantId, eventKey: `ifrs9:ecl:${g.loanId}` } })
    expect(posted.postingDate).toBe("2026-10-31")

    // October is closed: neither a new run nor a superseding one can be added, in the application or in the database
    await expect(monthly(g, "2026-10", "2027-01-05T11:00:00", { supersede: { runId: fixed.runId, reason: "too late" } })).rejects.toMatchObject({ code: "PERIOD_CLOSED" })
    await expect(db.ifrs9Run.create({
      data: { tenantId: g.tenantId, kind: "MONTHLY", periodKey: "2026-10", runDate: new Date("2026-10-31"), settings: {}, parameters: [], loanCount: 0, totalEadCents: 0, totalEclCents: 0, supersedesRunId: fixed.runId, reason: "raw" },
    })).rejects.toThrow(/closed/)
  })

  it("cannot be switched off while the ledger holds an allowance, nor made to start in a month that has closed", async () => {
    const h = await lender(true)
    const actor = { id: h.userId, email: "ifrs9-it@test.invalid" }
    for (const key of ["2026-08", "2026-09"]) await close(h, key)
    await monthly(h, "2026-10", "2026-10-31T23:50:00")
    await close(h, "2026-10")
    const off = await runWithTenant(h.tenantId, () => saveSettings(prisma, h.tenantId, { ...DEFAULT_SETTINGS, enabled: false }, actor))
    expect(off).toMatchObject({ ok: false, error: expect.stringContaining("allowance of R162.68") })
    expect((await db.ifrs9Config.findUniqueOrThrow({ where: { tenantId: h.tenantId } })).enabled).toBe(true)

    const early = await runWithTenant(h.tenantId, () => saveSettings(prisma, h.tenantId, { ...DEFAULT_SETTINGS, enabled: true, effectiveFromMonth: "2026-09" }, actor))
    expect(early).toMatchObject({ ok: false, error: expect.stringContaining("2026-11 or later") })
    expect(await runWithTenant(h.tenantId, () => saveSettings(prisma, h.tenantId, { ...DEFAULT_SETTINGS, enabled: true, effectiveFromMonth: "2026-12" }, actor))).toEqual({ ok: true })
  })

  it("asks for the mapping to be confirmed again when it predates the IFRS 9 accounts", async () => {
    const c = await lender(true)
    await db.accountingSettings.update({ where: { tenantId: c.tenantId }, data: { mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] } })
    for (const key of ["2026-08", "2026-09"]) await close(c, key)
    await monthly(c, "2026-10", "2026-10-31T23:50:00")
    expect((await plan(c, "2026-10")).refusal).toMatchObject({ code: "MAPPING_NOT_CONFIRMED" })
  })
})
