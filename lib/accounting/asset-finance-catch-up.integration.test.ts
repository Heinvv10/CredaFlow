/**
 * Q4 of slice 4b, against a real database: a lender that closed months under
 * the consumer-only export and then has asset finance posts the contract's
 * whole history in the next open month, labelled by origin. Closed months are
 * never reopened, and the lender must confirm the mapping again first because
 * the asset-finance accounts were not in the mapping it confirmed.
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/asset-finance-catch-up.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { day, INSTALMENT_JOURNAL_DEALS } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { createChargesLoan, createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { ASSET_FINANCE_ROLES } from "./accounts"
import { insertSourceLoan, removeSourceLoans } from "./asset-finance.integration-fixture"
import { closePeriod } from "./generate"
import { parsePeriodKey } from "./period"
import { planPeriod } from "./plan"
import { loanSources, type SourceLoan, type Vector } from "./sources"
import { loadLedger } from "./store"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const AFTER = new Date("2026-10-05T10:00:00+02:00")
let tenant: ChargesTenant

/** IS-1 of the acceptance deals, booked 2026-07-15, under ids of its own. */
const contract = (): SourceLoan => {
  const base = INSTALMENT_JOURNAL_DEALS[0].loan
  const af = base.assetFinance!
  return {
    ...base, id: "jrn-q4", reference: "AF-Q4-0001", schedule: base.schedule.map((r) => ({ ...r, id: `${r.id}-q4` })),
    payments: base.payments.map((p) => ({ ...p, id: `${p.id}-q4` })),
    assetFinance: { ...af, inceptionInvoice: af.inceptionInvoice && { ...af.inceptionInvoice, id: "inv-q4" } },
  }
}

const close = (periodKey: string) => runWithTenant(tenant.tenantId, () =>
  closePeriod(prisma, { tenantId: tenant.tenantId, periodKey, userId: tenant.userId, userEmail: "af-q4@test.invalid", now: AFTER }))
const plan = (periodKey: string) => runWithTenant(tenant.tenantId, () => planPeriod(prisma, tenant.tenantId, parsePeriodKey(periodKey)!, AFTER))
const nonEmpty = (v: Vector) => Object.fromEntries(Object.entries(v).filter(([, cents]) => cents !== 0))

suite.sequential("asset finance joining a lender that already closed months (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await createChargesLoan(db, tenant)
    await removeSourceLoans(db, ["jrn-q4"])
    await db.accountingSettings.create({ data: { tenantId: tenant.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08" } })
  })
  afterAll(async () => { await removeSourceLoans(db, ["jrn-q4"]); await db.$disconnect() })

  it("closes the consumer-only month without the asset-finance accounts being confirmed", async () => {
    expect((await close("2026-08")).created).toBe(true)
  })

  it("refuses the next month once a contract exists, until the mapping is confirmed again", async () => {
    await insertSourceLoan(db, tenant, contract())
    expect((await plan("2026-09")).refusal).toMatchObject({ code: "MAPPING_NOT_CONFIRMED", message: expect.stringContaining("AF_INSTALMENT_DEBTORS") })
    await db.accountingSettings.update({ where: { tenantId: tenant.tenantId }, data: { mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] } })
    expect((await plan("2026-09")).refusal).toBeNull()
  })

  it("posts the contract's history in September, dated by origin, each source once and the receivable tied", async () => {
    const out = await close("2026-09")
    const entries = await db.accountingLedgerEntry.findMany({ where: { batchId: out.batchId, loanId: "jrn-q4" }, orderBy: { eventKey: "asc" } })
    const inception = entries.find((e) => e.baseKey === "af:jrn-q4:inception")!
    expect(inception).toMatchObject({ eventType: "ASSET_INCEPTION", postingDate: "2026-09-01", eventDate: day("2026-07-15") })
    expect(inception.description).toContain("AF-Q4-0001")
    // Row 1 fell due on 08-15, in the closed August: it posts now, on the first day, dated 08-15. Row 2 (09-15) posts on its day.
    expect(entries.find((e) => e.baseKey === "af:jrn-q4:row:is1-r1-q4")).toMatchObject({ postingDate: "2026-09-01", eventDate: day("2026-08-15") })
    expect(entries.find((e) => e.baseKey === "af:jrn-q4:row:is1-r2-q4")).toMatchObject({ postingDate: "2026-09-15" })
    const { posted } = await runWithTenant(tenant.tenantId, () => loadLedger(prisma, tenant.tenantId))
    for (const s of loanSources(contract(), day("2026-10-01")).filter((x) => Object.keys(nonEmpty(x.vector)).length > 0)) expect(nonEmpty(posted.get(s.baseKey) ?? {})).toEqual(nonEmpty(s.vector))
    expect((await plan("2026-10")).reconciliation.mismatches).toEqual([])
  })
})
