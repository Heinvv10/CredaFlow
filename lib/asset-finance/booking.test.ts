import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"

// bookDeal's refusals (review item 9): every one answers before anything is
// written. The transaction, the row locks and the reads are faked; the
// solver, the rate resolution and the refusal logic are real. The written
// booking is proven against a real database in
// lib/asset-finance/booking-terms.integration.test.ts.
const m = vi.hoisted(() => ({
  tx: {
    $queryRaw: vi.fn(),
    assetFinanceDeal: { findFirst: vi.fn() },
    referenceRate: { findFirst: vi.fn() },
    loan: { create: vi.fn() },
  },
}))
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (fn: (tx: unknown) => unknown) => fn(m.tx) } }))

import { bookDeal } from "./booking"
import { solveDealStructure } from "./deal-structure"
import { termsFromDeal } from "./deal-terms"
import { dbDate } from "./dates"

const TODAY = "2026-10-13"
const asset = {
  id: "asset-1", make: "TEST", model: "EX-1", year: 2025, serialNumber: "TESTSERIAL1", vin: "TESTVIN1",
  cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000,
}
const structure = {
  depositCents: 17_250_000, tradeInCents: 0, financedFeesCents: 0, balloonCents: 20_000_000,
  weights: Array.from({ length: 36 }, () => 1), structurePreset: "MONTHLY", firstDueDate: dbDate("2026-11-13"),
  vatDeferralPeriodIndex: null, rateBasis: "PRIME" as const, rateMargin: new Prisma.Decimal("0.01"), fixedRate: null,
}
const signedSolve = solveDealStructure(asset, termsFromDeal(structure), { annualRate: "0.1175", reference: null }, TODAY)
if (!signedSolve.ok) throw new Error("fixture structure does not solve")

function deal(over: Record<string, unknown> = {}) {
  return {
    ...structure,
    id: "deal-1",
    status: "CONTRACTED",
    contractType: "INSTALMENT_SALE",
    plannedStartDate: dbDate(TODAY),
    signedBaseInstalmentCents: signedSolve.ok ? signedSolve.result.baseInstalmentCents : 0,
    signedResultingRate: new Prisma.Decimal("0.1175"),
    signedTotalInterestCents: signedSolve.ok ? signedSolve.result.totalInterestCents : 0,
    signedArrearsMarginRate: new Prisma.Decimal("0.02"),
    signedCollectionFeeCents: 45_000,
    checklist: [{ attestedIdentifier: "TESTSERIAL1" }],
    application: { id: "app-1", status: "APPROVED", ncaRegime: "NON_NCA", productId: "p-1", appliedAmount: 155_250_000, approvedAmount: 155_250_000 },
    asset,
    entity: { id: "e-1", legalName: "TEST Co", vatNumber: null, addressLine1: "1 Test Rd", addressLine2: null, city: "Testville", province: null, postalCode: null },
    payout: { id: "payout-1", status: "APPROVED", amountCents: 155_250_000, supplierBankAccount: { status: "APPROVED" } },
    ...over,
  }
}
const actor = { tenantId: "tenant-1", userId: "admin-1", userEmail: "admin@lender.test" }
const book = () => bookDeal(actor, "deal-1", TODAY)
const prime = (rate: string) => ({ effectiveDate: new Date("2020-01-01T00:00:00Z"), rate: new Prisma.Decimal(rate) })

beforeEach(() => {
  vi.clearAllMocks()
  m.tx.$queryRaw.mockResolvedValue([{ status: "CONTRACTED", applicationId: "app-1", assetId: "asset-1" }])
  m.tx.assetFinanceDeal.findFirst.mockResolvedValue(deal())
  m.tx.referenceRate.findFirst.mockResolvedValue(prime("0.1075"))
})

describe("bookDeal refusals: nothing is written", () => {
  it.each([
    ["no_payout", { payout: null }],
    ["payout_not_approved", { payout: { ...deal().payout, status: "PENDING_APPROVAL" } }],
    ["account_not_approved", { payout: { ...deal().payout, supplierBankAccount: { status: "SUPERSEDED" } } }],
    ["application_not_ready", { application: { ...deal().application, status: "UNDER_REVIEW" } }],
    ["entity_nca_booking_not_ready", { application: { ...deal().application, ncaRegime: "NCA" } }],
    ["asset_changed", { payout: { ...deal().payout, amountCents: 155_250_001 } }],
    ["asset_changed", { checklist: [{ attestedIdentifier: "TESTSERIAL2" }] }],
    ["asset_changed", { checklist: [] }],
    ["first_due_passed", { firstDueDate: dbDate(TODAY) }],
    ["terms_changed", { signedBaseInstalmentCents: (signedSolve.ok ? signedSolve.result.baseInstalmentCents : 0) + 1 }],
    ["terms_changed", { signedTotalInterestCents: (signedSolve.ok ? signedSolve.result.totalInterestCents : 0) - 1 }],
    ["terms_changed", { application: { ...deal().application, approvedAmount: 155_250_100 } }],
    ["not_prepared", { plannedStartDate: null }],
    ["start_passed", { plannedStartDate: dbDate("2026-10-12") }],
  ])("%s for %j", async (reason, over) => {
    m.tx.assetFinanceDeal.findFirst.mockResolvedValue(deal(over))
    expect(await book()).toMatchObject({ kind: "refused", reason })
    expect(m.tx.loan.create).not.toHaveBeenCalled()
  })

  it("terms_changed when the reference rate in force on the start date is not the signed one", async () => {
    m.tx.referenceRate.findFirst.mockResolvedValue(prime("0.1100"))
    expect(await book()).toMatchObject({ kind: "refused", reason: "terms_changed", error: expect.stringMatching(/0.12 is not|not the signed 0.1175/) })
    expect(m.tx.loan.create).not.toHaveBeenCalled()
  })

  it("resolves the rate on the planned start date, not the booking day", async () => {
    m.tx.assetFinanceDeal.findFirst.mockResolvedValue(deal({ checklist: [] }))
    await book()
    m.tx.assetFinanceDeal.findFirst.mockResolvedValue(deal({ plannedStartDate: dbDate("2026-10-20") }))
    await book()
    expect(m.tx.referenceRate.findFirst).toHaveBeenLastCalledWith(expect.objectContaining({
      where: expect.objectContaining({ effectiveDate: { lte: dbDate("2026-10-20") } }),
    }))
  })

  it("not_contracted and already_booked from the locked row", async () => {
    m.tx.$queryRaw.mockResolvedValue([{ status: "APPROVED", applicationId: "app-1", assetId: "asset-1" }])
    expect(await book()).toMatchObject({ kind: "refused", reason: "not_contracted" })
    m.tx.$queryRaw.mockResolvedValue([{ status: "BOOKED", applicationId: "app-1", assetId: "asset-1" }])
    expect(await book()).toMatchObject({ kind: "refused", reason: "already_booked" })
    m.tx.$queryRaw.mockResolvedValue([])
    expect(await book()).toEqual({ kind: "not_found" })
  })
})
