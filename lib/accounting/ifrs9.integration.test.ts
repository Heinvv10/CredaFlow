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
const monthly = (t: ChargesTenant, iso: string) => runWithTenant(t.tenantId, () => executeRun(t.tenantId, { kind: "MONTHLY", now: at(iso) }))

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

    await monthly(a, "2026-10-31T23:50:00")
    const ready = await plan(a, "2026-10")
    expect(ready.refusal).toBeNull()
    // The borrower's receivable is untouched: the reconciliation control still ties.
    expect(ready.reconciliation.mismatches).toEqual([])
    await close(a, "2026-10")
    // EAD 216 900 (R2 000 principal + R100 interest + R69 fees), ECL = 216 900 x 15% x 50% = 16 267.5 -> 16 268
    expect(ifrs9Of(await totals(a.tenantId))).toEqual({ ECL_ALLOWANCE: -16_268, ECL_EXPENSE: 16_268, INTEREST_SUSPENSE: 0 })
  })

  it("at 90 days past due moves to Stage 3: the allowance grows by the movement and the instalment's interest leaves income for suspense", async () => {
    await monthly(a, "2026-11-30T23:50:00")
    await close(a, "2026-11")
    const t = await totals(a.tenantId)
    // EAD 200 000 + 10 000 + 6 900 - 10 000 suspended = 206 900; ECL = 206 900 x 100% x 60% = 124 140
    expect(ifrs9Of(t)).toEqual({ ECL_ALLOWANCE: -124_140, ECL_EXPENSE: 124_140, INTEREST_SUSPENSE: -10_000 })
    // R100.00 of interest income recognised when the instalment fell due is now held back: income nets to nil
    expect(t.INTEREST_INCOME).toBe(0)
    // the receivable still holds everything owed
    expect(t.LOAN_BOOK).toBe(216_900)
  })

  it("on write-off releases the allowance and takes the suspended interest off the bad debt, not into income", async () => {
    await db.loan.update({ where: { id: a.loanId }, data: { status: "WRITTEN_OFF", writeOffAt: at("2026-12-15T10:00:00"), closedAt: at("2026-12-15T10:00:00") } })
    const run = await monthly(a, "2026-12-31T23:50:00")
    expect(run.loanCount, "a written-off loan is not on the collectible book").toBe(0)
    expect((await plan(a, "2026-12")).refusal).toBeNull()
    await close(a, "2026-12")
    const t = await totals(a.tenantId)
    expect(ifrs9Of(t)).toEqual({ ECL_ALLOWANCE: 0, ECL_EXPENSE: 0, INTEREST_SUSPENSE: 0 })
    // the write-off takes the whole R2 169 off the book; R100.00 of it was never income, so the bad debt is R2 069
    expect(t.LOAN_BOOK).toBe(0)
    expect(t.BAD_DEBT_EXPENSE).toBe(206_900)
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

  it("asks for the mapping to be confirmed again when it predates the IFRS 9 accounts", async () => {
    const c = await lender(true)
    await db.accountingSettings.update({ where: { tenantId: c.tenantId }, data: { mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] } })
    for (const key of ["2026-08", "2026-09"]) await close(c, key)
    await monthly(c, "2026-10-31T23:50:00")
    expect((await plan(c, "2026-10")).refusal).toMatchObject({ code: "MAPPING_NOT_CONFIRMED" })
  })
})
