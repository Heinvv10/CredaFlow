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
import { ASSET_FINANCE_ROLES } from "./accounts"
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
  afterAll(async () => { await removeSourceLoans(db, [LATE.id, APPROVED.id]) })

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

// A withdrawn recovery with a repossession VAT event is not a state the rules produce (the event is made when a sale
// completes, and a recovery with a sale cannot be withdrawn). It blocks from the EARLIEST of the withdrawal, the event and the sale.
const WITHDRAWN = ((): SourceLoan => {
  const loan = sale("jrn-h1-wd", "2026-07-15", true)
  return {
    ...loan,
    assetFinance: {
      ...loan.assetFinance!,
      recoveries: [{
        id: "r-h1-wd", proceedsDate: null, proceedsPaymentId: null, surplusCents: 0, withdrawnAt: new Date("2026-10-03T09:00:00+02:00"),
        costs: [{ id: "c-h1-wd", netCents: 10_000, vatCents: 1_500, grossCents: 11_500, treatment: "DEDUCT_FROM_PROCEEDS", incurredOn: day("2026-09-22") }],
        vatEvents: [], sale: null, refund: null,
      }],
    },
  }
})()

suite.sequential("a withdrawn recovery with a VAT event blocks from the earliest date (real Postgres)", () => {
  let lender: ChargesTenant
  const planFor = (key: string) => runWithTenant(lender.tenantId, () => planPeriod(prisma, lender.tenantId, parsePeriodKey(key)!, AFTER))
  const vatEvent = (iso: string) => db.$transaction([
    db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
    db.recoveryVatEvent.create({ data: {
      id: "vat-h1-wd", tenantId: lender.tenantId, recoveryId: "r-h1-wd", kind: "REPOSSESSION_DEEMED_SUPPLY", eventDate: new Date(`${iso}T00:00:00Z`), dealContractType: "INSTALMENT_SALE",
      debtorVatVendor: false, deemedSupplyValueCents: 575_000, inputTaxClaimCents: 75_000, outputTaxCents: 0, vatRateTenThousandths: 1500, basis: "Synthetic", recordedById: lender.userId,
    } }),
  ])
  const removeVatEvent = () => db.$transaction([db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"), db.recoveryVatEvent.deleteMany({ where: { id: "vat-h1-wd" } })])

  beforeAll(async () => {
    lender = await createChargesTenant(db, false)
    await removeSourceLoans(db, [WITHDRAWN.id])
    await insertSourceLoan(db, lender, WITHDRAWN)
    await db.accountingSettings.create({ data: { tenantId: lender.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08", mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] } })
  })
  afterAll(async () => { await removeSourceLoans(db, [WITHDRAWN.id]) })

  it("a VAT event in September on a recovery withdrawn in October blocks September, not August", async () => {
    await vatEvent("2026-09-15")
    try {
      expect((await planFor("2026-08")).refusal).toBeNull()
      expect((await runWithTenant(lender.tenantId, () => closePeriod(prisma, { tenantId: lender.tenantId, periodKey: "2026-08", userId: lender.userId, userEmail: "h1@test.invalid", now: AFTER }))).created).toBe(true)
      expect((await planFor("2026-09")).refusal).toMatchObject({ code: "AF_SOURCE_UNSUPPORTED", message: expect.stringContaining("withdrawn recovery") })
    } finally {
      await removeVatEvent()
    }
    expect((await planFor("2026-09")).refusal).toBeNull()
  })

  it("an event dated after the withdrawal leaves September open and blocks October, from the withdrawal itself", async () => {
    // withdrawn 3 Oct, event 20 Nov: only the withdrawal (and not the event) is before the end of October
    await vatEvent("2026-11-20")
    try {
      expect((await planFor("2026-09")).refusal).toBeNull()
      expect((await runWithTenant(lender.tenantId, () => closePeriod(prisma, { tenantId: lender.tenantId, periodKey: "2026-09", userId: lender.userId, userEmail: "h1@test.invalid", now: AFTER }))).created).toBe(true)
      expect((await planFor("2026-10")).refusal).toMatchObject({ code: "AF_SOURCE_UNSUPPORTED", message: expect.stringContaining("withdrawn recovery") })
    } finally {
      await removeVatEvent()
    }
  })
})


// A sale blocked for its invoice or price, and a withdrawn recovery that has a sale, block from the EARLIER of the sale's
// completion and its invoice's date. The scenarios differ only in which of the two dates comes first.
const SALE_INCL = 920_000
const withSale = (id: string, invoiceOn: string, over: { withdrawnAt?: Date }): SourceLoan => {
  const loan = sale(id, "2026-07-15", true)
  return {
    ...loan,
    assetFinance: {
      ...loan.assetFinance!,
      recoveries: [{
        id: `r-${id}`, proceedsDate: null, proceedsPaymentId: null, surplusCents: 0, withdrawnAt: over.withdrawnAt ?? null, costs: [], vatEvents: [],
        sale: { id: `s-${id}`, priceInclVatCents: SALE_INCL, invoice: invoice(`inv-s-${id}`, invoiceOn, 800_000, 120_000) }, refund: null,
      }],
    },
  }
}

const SALE_SCENARIOS = [
  // [id, invoice date, completedAt, mismatched price?, withdrawn?, what blocks September]
  ["jrn-h1-s1", "2026-09-10", "2026-10-05T09:00:00+02:00", true, false, "the invoice is dated first"],
  ["jrn-h1-s2", "2026-10-02", "2026-09-05T09:00:00+02:00", true, false, "the completion is first"],
  ["jrn-h1-s3", "2026-09-10", "2026-09-10T09:00:00+02:00", false, true, "a withdrawn recovery that has a sale: the sale is before the withdrawal"],
] as const

suite.sequential("a sale blocks from the earlier of its completion and its invoice (real Postgres)", () => {
  const lenders = new Map<string, ChargesTenant>()
  const planFor = (id: string, key: string) => runWithTenant(lenders.get(id)!.tenantId, () => planPeriod(prisma, lenders.get(id)!.tenantId, parsePeriodKey(key)!, AFTER))

  beforeAll(async () => {
    for (const [id, invoiceOn, completedAt, mismatched, withdrawn] of SALE_SCENARIOS) {
      const loan = withSale(id, invoiceOn, { withdrawnAt: withdrawn ? new Date("2026-10-03T09:00:00+02:00") : undefined })
      const lender = await createChargesTenant(db, false)
      lenders.set(id, lender)
      await removeSourceLoans(db, [id])
      await insertSourceLoan(db, lender, loan)
      await db.$transaction([
        db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
        db.$executeRawUnsafe(`UPDATE "RemarketingSale" SET "completedAt" = '${completedAt}'${mismatched ? `, "priceInclVatCents" = ${SALE_INCL - 100}` : ""} WHERE "id" = 's-${id}'`),
      ])
      await db.accountingSettings.create({ data: { tenantId: lender.tenantId, mappingConfirmedAt: new Date(), goLiveMonth: "2026-08", mappingConfirmedRoles: [...ASSET_FINANCE_ROLES] } })
    }
  })
  afterAll(async () => { await removeSourceLoans(db, SALE_SCENARIOS.map(([id]) => id)) })

  it.each(SALE_SCENARIOS.map((s) => [s[0], s[5]] as const))("%s: August is open, September is refused (%s)", async (id) => {
    expect((await planFor(id, "2026-08")).refusal).toBeNull()
    const lender = lenders.get(id)!
    expect((await runWithTenant(lender.tenantId, () => closePeriod(prisma, { tenantId: lender.tenantId, periodKey: "2026-08", userId: lender.userId, userEmail: "h1@test.invalid", now: AFTER }))).created).toBe(true)
    expect((await planFor(id, "2026-09")).refusal).toMatchObject({ code: "AF_SOURCE_UNSUPPORTED" })
  })
})

afterAll(async () => { await db.$disconnect() })
