/**
 * H1 of the PR review, against a real database: an instalment sale posts when its supplier payout is
 * released, and a contract that cannot be posted blocks only the months from the day it was booked or
 * released: a contract booked after a month cannot block that month. (The app never leaves a booked
 * contract with an unreleased payout: booking releases it in the same transaction. The unreleased case
 * is written straight to the tables here.)
 *
 *   RUN_ACCOUNTING_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/accounting/asset-finance-release-timing.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { afLoan, day, invoice } from "@/lib/asset-finance/__fixtures__/acceptance-journal-deals"
import { createChargesTenant, type ChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { insertSourceLoan, removeSourceLoans } from "./asset-finance.integration-fixture"
import { closePeriod } from "./generate"
import { parsePeriodKey } from "./period"
import { planPeriod } from "./plan"
import { independentBook } from "./reconcile"
import type { SourceLoan } from "./source-types"

const suite = process.env.RUN_ACCOUNTING_IT === "1" ? describe : describe.skip
const db = new PrismaClient()
const AFTER = new Date("2026-11-05T10:00:00+02:00")
let tenant: ChargesTenant

const row = (loan: string, n: number, due: string, opening: number | null, totalDue: number) =>
  ({ id: `${loan}-r${n}`, installmentNo: n, dueDate: day(due), interestDue: 0, feesDue: 0, creditLifePremiumDue: 0, totalDue, totalPaid: 0, openingBalanceCents: opening })

/** An instalment sale; `releasedAt` is when the supplier was paid (the invoice is the same day). */
const sale = (id: string, releasedAt: string, openings: boolean): SourceLoan => afLoan({
  id, reference: `AF-${id.toUpperCase()}`, principal: 100_000, startDate: day(releasedAt), receivableRole: "AF_INSTALMENT_DEBTORS",
  schedule: [row(id, 1, "2026-12-15", openings ? 100_000 : null, 100_000)],
  assetFinance: {
    contractType: "INSTALMENT_SALE", financedFeesCents: 0, payout: { amountCents: 100_000, releasedAt: new Date(`${releasedAt}T09:00:00+02:00`) },
    inceptionInvoice: invoice(`inv-${id}`, releasedAt, 86_957, 13_043), asset: { exclVatCents: 0, vatCents: 0 }, rentals: [], sundryInvoices: [], creditNotes: [], fund: null, recoveries: [],
  },
})

// LATE: no schedule opening balances, released on 2026-10-14; APPROVED: booked 2026-10-14 but its payout is approved and never released.
const LATE = sale("jrn-h1-late", "2026-10-14", false)
const APPROVED = sale("jrn-h1-approved", "2026-10-14", true)

const plan = (key: string) => runWithTenant(tenant.tenantId, () => planPeriod(prisma, tenant.tenantId, parsePeriodKey(key)!, AFTER))
const close = (key: string) => runWithTenant(tenant.tenantId, () => closePeriod(prisma, { tenantId: tenant.tenantId, periodKey: key, userId: tenant.userId, userEmail: "h1@test.invalid", now: AFTER }))

suite.sequential("an instalment sale posts when its payout is released (real Postgres)", () => {
  beforeAll(async () => {
    tenant = await createChargesTenant(db, false)
    await removeSourceLoans(db, [LATE.id, APPROVED.id])
    await insertSourceLoan(db, tenant, LATE)
    await insertSourceLoan(db, tenant, APPROVED)
    // The second sale's payout was approved and never released.
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.$executeRawUnsafe(`UPDATE "Payout" SET "status" = 'APPROVED', "releasedAt" = NULL, "releasedById" = NULL WHERE "id" = 'payout-${APPROVED.id}'`),
    ])
    await db.accountingSettings.create({ data: { tenantId: tenant.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08", mappingConfirmedRoles: ["AF_INSTALMENT_DEBTORS", "INPUT_VAT"] } })
  })
  afterAll(async () => { await removeSourceLoans(db, [LATE.id, APPROVED.id]); await db.$disconnect() })

  it("a contract released in October, which cannot be posted yet, does not block August", async () => {
    const august = await plan("2026-08")
    expect(august.refusal).toBeNull()
    expect(august.entries).toEqual([])
    expect(august.controls).toEqual([])
  })

  it("a payout never released has posted nothing, and its contract (booked in October) blocks neither August nor September", async () => {
    const book = await runWithTenant(tenant.tenantId, () => independentBook(prisma, tenant.tenantId, day("2026-11-01")))
    expect(book.has(APPROVED.id)).toBe(false)
    expect((await plan("2026-09")).entries).toEqual([])
  })

  it("blocks the months from the release on: October, once August and September are closed", async () => {
    expect((await close("2026-08")).created).toBe(true)
    expect((await close("2026-09")).created).toBe(true)
    const october = await plan("2026-10")
    expect(october.refusal).toMatchObject({ code: "AF_SOURCE_UNSUPPORTED", message: expect.stringContaining("a schedule row has no opening balance") })
    expect(october.refusal?.message).toContain("the supplier payout has not been released")
    expect(october.controls).toEqual([])
    await expect(close("2026-10")).rejects.toMatchObject({ code: "AF_SOURCE_UNSUPPORTED" })
  })
})
