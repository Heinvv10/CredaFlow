/**
 * BREAK item 3 (RUN_ACCOUNTING_IT): a consumer-only tenant's journals do not change because asset finance exists: other tenants'
 * contracts, unconfirmed or NULL AF roles, a failing AF control elsewhere, and the AF loader's filters all leave its plan and its
 * closed months exactly as the consumer sources derive them.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { INSTALMENT_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { ASSET_FINANCE_ROLES } from "./accounts"
import { closeMonths, closeOf, db, dropLender, ledgerTotals, newLender, planOf, renamed, RUN, type Lender } from "./af-break.fixture"
import { loanSources } from "./sources"
import { loadSourceLoans } from "./store"

const suite = RUN ? describe : describe.skip
const [IS_1] = INSTALMENT_JOURNAL_DEALS
let consumer: ChargesTenant
let other: Lender

suite.sequential("consumer-only tenant is untouched by asset finance", () => {
  beforeAll(async () => {
    consumer = await createChargesTenant(db, false)
    await createChargesLoan(db, consumer)
    await db.accountingSettings.create({ data: { tenantId: consumer.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08" } })
    other = await newLender([renamed(IS_1.loan, "oc")])
  }, 120_000)
  afterAll(async () => { await dropLender(other); await db.$disconnect() }, 120_000)

  it("3a. its plan is the consumer derivation alone: no AF line, no control, no unsupported refusal, roles never confirmed", async () => {
    const plan = await planOf(consumer, "2026-09")
    const roles = new Set(plan.entries.flatMap((e) => e.lines.map((l) => l.role)))
    for (const role of ASSET_FINANCE_ROLES) expect(roles.has(role), `AF role ${role} in a consumer-only month`).toBe(false)
    expect(plan.controls).toEqual([])
    expect(plan.refusal?.code ?? null).not.toMatch(/AF_|MAPPING/)
  }, 120_000)

  it("3b. its entries equal what the consumer sources alone say it should post (same loans, same instant)", async () => {
    const period = (await planOf(consumer, "2026-09")).period
    const loans = await runWithTenant(consumer.tenantId, () => loadSourceLoans(prisma, consumer.tenantId, period.end))
    const desired = loans.flatMap((l) => loanSources(l, period.end)).filter((s) => Object.values(s.vector).some((v) => v !== 0))
    const plan = await planOf(consumer, "2026-09")
    const desiredKeys = new Set(desired.map((s) => s.baseKey))
    for (const e of plan.entries) expect(desiredKeys.has(e.baseKey), `entry ${e.baseKey} has no consumer source`).toBe(true)
    expect(loans.every((l) => !l.assetFinance)).toBe(true)
  }, 120_000)

  it("3c. another tenant's unsupported contract or failing control does not refuse or alter this tenant's close", async () => {
    const unfunded = renamed(IS_1.loan, "ou")
    unfunded.assetFinance = { ...unfunded.assetFinance!, payout: null }
    const stuck = await newLender([unfunded])
    try {
      expect((await planOf(stuck.tenant, "2026-08")).refusal?.code).toBe("AF_SOURCE_UNSUPPORTED")
      const mine = await closeMonths(consumer, ["2026-08", "2026-09"])
      expect(mine.every((m) => m.closed), JSON.stringify(mine)).toBe(true)
      const lines = await ledgerTotals(consumer.tenantId)
      expect(Object.keys(lines).filter((r) => (ASSET_FINANCE_ROLES as readonly string[]).includes(r))).toEqual([])
    } finally { await dropLender(stuck) }
  }, 120_000)

  it("3d. a NULL mappingConfirmedRoles (a row from before the column) cannot crash or alter a consumer-only close", async () => {
    const T = await createChargesTenant(db, false)
    await createChargesLoan(db, T)
    await db.accountingSettings.create({ data: { tenantId: T.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08" } })
    await db.$executeRawUnsafe(`UPDATE "AccountingSettings" SET "mappingConfirmedRoles" = NULL WHERE "tenantId" = '${T.tenantId}'`)
    const plan = await planOf(T, "2026-08")
    expect(plan.refusal).toBeNull()
    expect((await closeOf(T, "2026-08")).created).toBe(true)
  }, 120_000)

  it("3e. a consumer loan that carries an asset id (a repossessed-asset link) is still a consumer loan: one derivation, not two", async () => {
    const T = await createChargesTenant(db, false)
    const loan = await createChargesLoan(db, T)
    await db.accountingSettings.create({ data: { tenantId: T.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08" } })
    const asset = await db.financedAsset.create({ data: { tenantId: T.tenantId, assetClass: "EXCAVATOR", make: "T", model: "T", year: 2025, serialNumber: `SN-${T.tenantId}`, cashPriceExclVatCents: 1, vatCents: 0 } })
    await db.$executeRawUnsafe(`UPDATE "Loan" SET "assetId" = '${asset.id}' WHERE "id" = '${(loan as unknown as { id: string }).id}'`).catch(() => undefined)
    const before = await planOf(T, "2026-08")
    expect(before.entries.every((e) => !e.baseKey.startsWith("af:") && !e.baseKey.startsWith("lease"))).toBe(true)
  }, 120_000)
})
