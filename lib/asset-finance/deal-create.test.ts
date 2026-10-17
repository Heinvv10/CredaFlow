import { beforeEach, describe, expect, it, vi } from "vitest"
import { Prisma } from "@prisma/client"
import type { RegimeTx } from "./classification"
import { createDeal } from "./deal-create"
import type { DealCreateInput } from "./deal-input"

const input: DealCreateInput = {
  clientId: null,
  entityId: "entity-1",
  contractType: "INSTALMENT_SALE",
  supplierId: "supplier-1",
  productId: "product-1",
  assetId: "asset-1",
  terms: {
    depositCents: 17_250_000, tradeInCents: 0, financedFeesCents: 0, balloonCents: 0,
    preset: "MONTHLY", weights: new Array(60).fill(1), firstDueDate: "2026-12-15", vatDeferralPeriodIndex: null,
    rate: { basis: "PRIME", margin: "0.0100", fixedRate: null },
  },
}

function fakeTx() {
  const tx = {
    $queryRaw: vi.fn(async () => [{ id: "asset-1" }]),
    businessEntity: { findFirst: vi.fn(async () => ({ id: "entity-1", legalName: "TEST Co", type: "COMPANY", annualTurnover: null, totalAssetValue: null, financialsEvidenceIds: [] })) },
    client: { findFirst: vi.fn(async () => ({ id: "client-1", firstName: "TEST", lastName: "Owner" })) },
    supplier: { findFirst: vi.fn(async () => ({ active: true })) },
    loanProduct: {
      findFirst: vi.fn(async () => ({ id: "product-1", minAmount: 100, maxAmount: 1_000_000_000, minTermDays: 30, maxTermDays: 3650 })),
    },
    financedAsset: {
      findFirst: vi.fn(async () => ({
        cashPriceExclVatCents: 150_000_000, vatCents: 22_500_000, releasedAt: null as Date | null, lessorStatus: null as string | null,
        make: "TEST", model: "EX-1", serialNumber: "TEST0000000000001",
      })),
    },
    referenceRate: {
      findFirst: vi.fn(async () => ({ effectiveDate: new Date("2026-01-01T00:00:00Z"), rate: new Prisma.Decimal("0.1075") }) as unknown),
    },
    assetFinanceDeal: {
      findFirst: vi.fn(async () => null as unknown),
      create: vi.fn(async () => ({ id: "deal-1" })),
    },
    loanApplication: { create: vi.fn(async () => ({ id: "app-1", reference: "AF-1" })) },
    auditLog: { create: vi.fn(async () => ({})) },
  }
  return { tx, asTx: tx as unknown as RegimeTx }
}

const run = (asTx: RegimeTx, over: Partial<DealCreateInput> = {}) =>
  createDeal(asTx, { tenantId: "tenant-1", userId: "officer-a", input: { ...input, ...over } })

describe("createDeal", () => {
  let fake: ReturnType<typeof fakeTx>
  beforeEach(() => {
    fake = fakeTx()
  })

  it("creates the DRAFT entity application for the financed amount and the deal, audited", async () => {
    expect(await run(fake.asTx)).toEqual({ kind: "created", dealId: "deal-1" })
    // 172 500 000 cash price incl. VAT − 17 250 000 deposit.
    expect(fake.tx.loanApplication.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1", entityId: "entity-1", productId: "product-1", appliedAmount: 155_250_000, status: "DRAFT",
        // 2026-11-15 (start) → 2031-11-15 (60th due date) = 1826 days.
        appliedTermDays: 1826,
      }),
      select: { id: true, reference: true },
    })
    expect(fake.tx.assetFinanceDeal.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ applicationId: "app-1", status: "DRAFT", rateBasis: "PRIME", rateMargin: "0.0100", fixedRate: null }),
      select: { id: true },
    })
    expect(fake.tx.auditLog.create).toHaveBeenCalledWith({ data: expect.objectContaining({ action: "ASSET_DEAL_CREATED", entityId: "deal-1" }) })
  })

  it("classifies an instalment sale to a small evidenced juristic purchaser for the CPA", async () => {
    fake.tx.businessEntity.findFirst.mockResolvedValue({ id: "entity-1", legalName: "TEST Co", type: "COMPANY", annualTurnover: 100_000_000, totalAssetValue: 100_000_000, financialsEvidenceIds: ["synthetic-afs"] } as never)
    expect(await run(fake.asTx)).toEqual({ kind: "created", dealId: "deal-1" })
    expect(fake.tx.assetFinanceDeal.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ isaCpaApplies: true, isaCpaRule: "CPA_JURISTIC_UNDER_THRESHOLD" }) }))
  })

  it("creates a sole-proprietor finance lease as an NCA client deal without classifying a juristic person", async () => {
    expect(await run(fake.asTx, { clientId: "client-1", entityId: null, contractType: "FINANCE_LEASE" })).toEqual({ kind: "created", dealId: "deal-1" })
    expect(fake.tx.businessEntity.findFirst).not.toHaveBeenCalled()
    expect(fake.tx.loanApplication.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ clientId: "client-1", entityId: null, ncaRegime: "NCA", ncaClassificationRule: "NATURAL_PERSON_NCA" }),
    }))
    expect(fake.tx.assetFinanceDeal.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ clientId: "client-1", entityId: null, contractType: "FINANCE_LEASE" }),
    }))
  })

  it("refuses an asset already on an open deal (409), checked with the asset row locked", async () => {
    fake.tx.assetFinanceDeal.findFirst.mockResolvedValue({ id: "deal-0", status: "SUBMITTED" })
    expect(await run(fake.asTx)).toEqual({ kind: "refused", status: 409, error: "The asset is already on an open deal (SUBMITTED)" })
    expect(fake.tx.$queryRaw).toHaveBeenCalled()
    expect(fake.tx.assetFinanceDeal.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "tenant-1", assetId: "asset-1", status: { notIn: ["REFUSED_NCA", "DECLINED", "CANCELLED"] } },
    }))
    expect(fake.tx.loanApplication.create).not.toHaveBeenCalled()
  })

  it("refuses a released asset (409)", async () => {
    const asset = await fake.tx.financedAsset.findFirst()
    fake.tx.financedAsset.findFirst.mockResolvedValue({ ...asset, releasedAt: new Date() })
    expect(await run(fake.asTx)).toMatchObject({ kind: "refused", status: 409 })
  })

  it.each(["RECOVERED", "SOLD_IN_REMARKETING"])("refuses an asset whose lessor status is %s (409)", async (lessorStatus) => {
    const asset = await fake.tx.financedAsset.findFirst()
    fake.tx.financedAsset.findFirst.mockResolvedValue({ ...asset, lessorStatus })
    expect(await run(fake.asTx)).toMatchObject({ kind: "refused", status: 409, error: expect.stringMatching(/recovery|remarketing/) })
  })

  it.each([
    ["an inactive supplier", (f: ReturnType<typeof fakeTx>) => f.tx.supplier.findFirst.mockResolvedValue({ active: false }), /inactive/],
    ["an unknown entity", (f: ReturnType<typeof fakeTx>) => f.tx.businessEntity.findFirst.mockResolvedValue(null as never), /entity/],
    ["an inactive or unknown product", (f: ReturnType<typeof fakeTx>) => f.tx.loanProduct.findFirst.mockResolvedValue(null as never), /product/],
    ["a missing reference rate", (f: ReturnType<typeof fakeTx>) => f.tx.referenceRate.findFirst.mockResolvedValue(null), /No PRIME reference rate/],
    ["an amount over the product maximum", (f: ReturnType<typeof fakeTx>) =>
      f.tx.loanProduct.findFirst.mockResolvedValue({ id: "product-1", minAmount: 100, maxAmount: 100_000_000, minTermDays: 30, maxTermDays: 3650 }),
      /outside the product/],
  ])("refuses %s (422) and writes nothing", async (_label, arrange, message) => {
    arrange(fake)
    const result = await run(fake.asTx)
    expect(result).toMatchObject({ kind: "refused", status: 422 })
    expect(result.kind === "refused" && result.error).toMatch(message)
    expect(fake.tx.loanApplication.create).not.toHaveBeenCalled()
  })

  it("refuses a structure the solver rejects (balloon >= financed amount) with its reason", async () => {
    const result = await run(fake.asTx, { terms: { ...input.terms, balloonCents: 200_000_000 } })
    expect(result).toMatchObject({ kind: "refused", status: 422, error: expect.stringMatching(/balloon/i) })
  })
})
