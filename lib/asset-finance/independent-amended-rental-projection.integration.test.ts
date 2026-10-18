/** Independent SQL/TypeScript projection parity; temporary synthetic correction rows only. */
import { PrismaClient } from "@prisma/client"
import { afterAll, describe, expect, it } from "vitest"
import { amendedLeaseRentals } from "./lease-rate-tax-adjustment"
const run = process.env.RUN_ASSET_FINANCE_REPRICE_IT === "1"
const db = run ? new PrismaClient() : null
;(run ? describe : describe.skip)("independent amended-rental projection boundaries", () => {
  afterAll(async () => { await db?.$disconnect() })
  it.each([
    [0, 0, 0], [0, -3, 0], [100, -103, 0], [100, -104, 0], [100, -100, 0], [100, -60, -40], [100, -101, 2],
    [100, 300, -250], [100, -101, 0], [100, 0.5, 0],
  ])("projects original=%s cumulative deltas=%s,%s", async (original, first, second) => {
    const sources = [
      { reason: "LATE_CLOSED_LEASE_RATE", contractualRows: { periodAdjustments: [{ periodNo: 1, exclVatCents: first }, { periodNo: 2, exclVatCents: 99999 }] } },
      { reason: "RATE_PAYOFF_CREDIT", contractualRows: { periodAdjustments: [{ periodNo: 1, exclVatCents: second }] } },
      { reason: "LEASE_SUPPLY_TAX_CANCELLED", contractualRows: { replacedByRentalFloor: true, periodNo: 1, exclVatAdjustmentCents: 3 } },
      { reason: "LEASE_SUPPLY_TAX_CANCELLED", contractualRows: { replacedByRentalFloor: false, periodNo: 1, exclVatAdjustmentCents: -99999 } },
    ]
    // The same connection's temporary table shadows only the function's input
    // relation. No foreign-key bypass, fixture state or shared database is used.
    const expected = original + first + second + 3
    let ts: number | undefined
    try { ts = (await amendedLeaseRentals({ assetFinanceRateCorrection: { findMany: async () => sources } } as never, "tenant", "loan", [{ periodNo: 1, rentalExclVatCents: original }]))[0].rentalExclVatCents } catch { /* Exactness refusal is also compared below. */ }
    const project = db!.$transaction(async tx => {
      await tx.$executeRawUnsafe('CREATE TEMP TABLE "AssetFinanceRateCorrection" ("tenantId" TEXT,"loanId" TEXT,"reason" TEXT,"contractualRows" JSONB) ON COMMIT DROP')
      for (const source of sources) await tx.$executeRaw`INSERT INTO "AssetFinanceRateCorrection" VALUES ('tenant','loan',${source.reason},${JSON.stringify(source.contractualRows)}::JSONB)`
      // Other tenant/loan amendments must never affect the claim.
      await tx.$executeRawUnsafe(`INSERT INTO "AssetFinanceRateCorrection" VALUES ('other','loan','RATE_PAYOFF_CREDIT','{"periodAdjustments":[{"periodNo":1,"exclVatCents":99999}]}'),('tenant','other','RATE_PAYOFF_CREDIT','{"periodAdjustments":[{"periodNo":1,"exclVatCents":99999}]}')`)
      const [row] = await tx.$queryRaw<Array<{ cents: bigint }>>`SELECT public."leaseAmendedRentalCents"('tenant','loan',1,${original}::INTEGER) AS cents`
      return Number(row.cents)
    })
    if (!Number.isSafeInteger(expected) || expected < 0) {
      expect(ts).toBeUndefined()
      await expect(project).rejects.toThrow(/non-negative exact cents/)
    } else {
      expect(ts).toBe(expected)
      expect(await project).toBe(expected)
    }
  })
})
