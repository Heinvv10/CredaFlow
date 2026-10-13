/**
 * Real-Postgres proof of the asset register rules added in review
 * (migration 20261013114100_asset_finance_review_assets), written straight
 * to the table so the database alone has to refuse them:
 *  - the duplicate checks compare assetIdentifierKey (case, every space incl.
 *    NBSP, and - / . _ ignored);
 *  - no control or zero-width character is stored (CHECK);
 *  - one unreleased asset's serial is not another's VIN (trigger);
 *  - the VAT is the VAT on the exclusive price at today's rate (trigger);
 *  - releasedAt is set once and never cleared (trigger).
 *
 *   RUN_ASSET_FINANCE_ASSETS_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/asset-identifiers.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_ASSET_FINANCE_ASSETS_IT === "1"
const suite = RUN ? describe : describe.skip
const db = RUN ? new PrismaClient() : null
const t = randomUUID().replaceAll("-", "").slice(0, 16)
const tenantId = `t_af_ident_${t}`

function database(): PrismaClient {
  if (!db) throw new Error("RUN_ASSET_FINANCE_ASSETS_IT=1 is required")
  return db
}
const asset = (serialNumber: string, vin: string | null = null, price = { cashPriceExclVatCents: 100_000, vatCents: 15_000 }) =>
  database().financedAsset.create({
    data: { tenantId, assetClass: "TLB", make: "TEST", model: "T-1", year: 2024, serialNumber, vin, ...price },
  })
const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (error) {
    const e = error as { code?: string; message?: string }
    return `${e.code ?? ""} ${e.message ?? String(error)}`
  }
  throw new Error("expected the database to refuse")
}

suite.sequential("asset identifiers, VAT and release (real Postgres)", () => {
  beforeAll(async () => {
    await database().tenant.create({ data: { id: tenantId, slug: `af-ident-${t}`, name: "Identifiers IT" } })
  })

  afterAll(async () => {
    if (!db) return
    await db.$transaction([
      db.$executeRawUnsafe("SET LOCAL session_replication_role = replica"),
      db.financedAsset.deleteMany({ where: { tenantId } }),
      db.tenant.deleteMany({ where: { id: tenantId } }),
    ])
    await db.$disconnect()
  })

  it.each([["TEST F8"], ["TEST-F8"], ["test.f8"], ["TEST/F8"], ["TEST_F8"], ["TEST F8"], ["TEST F8"], [" TESTF8 "]])(
    "a serial %j is the same machine as TESTF8 (unique on assetIdentifierKey)",
    async (variant) => {
      if ((await database().financedAsset.count({ where: { tenantId, serialNumber: "TESTF8" } })) === 0) await asset("TESTF8")
      expect(await refusal(() => asset(variant))).toMatch(/P2002[\s\S]*assetIdentifierKey\(serialNumber\)/)
      expect(await refusal(() => asset(`OTHER-${variant}`, variant))).toMatch(/P2002/)
    },
  )

  it.each([["TEST​F9"], ["TESTF9\t"], ["TESTF9\n"], ["﻿TESTF9"], ["TEST\u0007F9"]])(
    "refuses a control or zero-width character in a serial or VIN: %j",
    async (value) => {
      expect(await refusal(() => asset(value))).toContain("FinancedAsset_identifiers_printable")
      expect(await refusal(() => asset(`TESTF9-${randomUUID().slice(0, 4)}`, value))).toContain("FinancedAsset_identifiers_printable")
    },
  )

  it("refuses a serial that is another unreleased asset's VIN, and the reverse; one asset's own serial may be its VIN", async () => {
    await asset("TESTS10", "TESTV10")
    expect(await refusal(() => asset("TESTS11", "test-s10"))).toMatch(/P2002/)
    expect(await refusal(() => asset("TEST V10"))).toMatch(/P2002/)
    const other = await asset("TESTS12")
    expect(await refusal(() => database().financedAsset.update({ where: { id: other.id }, data: { vin: "TESTS10" } }))).toMatch(/P2002/)
    await expect(asset("TESTSAME13", "TESTSAME13")).resolves.toMatchObject({ vin: "TESTSAME13" })
  })

  it("a released asset frees its identifiers, across columns too", async () => {
    const first = await asset("TESTS20", "TESTV20")
    await database().financedAsset.update({ where: { id: first.id }, data: { releasedAt: new Date() } })
    await expect(asset("TESTV20", "TESTS20")).resolves.toMatchObject({ serialNumber: "TESTV20" })
  })

  it("the VAT must be the VAT on the exclusive price at today's rate, on insert and on a price change", async () => {
    expect(await refusal(() => asset("TESTVAT1", null, { cashPriceExclVatCents: 100_000, vatCents: 15_001 })))
      .toContain("An asset's VAT must be the VAT on its exclusive cash price at the rate in force today (15000 cents)")
    await expect(asset("TESTVAT2", null, { cashPriceExclVatCents: 10, vatCents: 2 })).resolves.toMatchObject({ vatCents: 2 })
    const row = await asset("TESTVAT3")
    expect(await refusal(() => database().financedAsset.update({ where: { id: row.id }, data: { cashPriceExclVatCents: 200_000 } })))
      .toContain("An asset's VAT must be the VAT on its exclusive cash price")
    await expect(database().financedAsset.update({ where: { id: row.id }, data: { cashPriceExclVatCents: 200_000, vatCents: 30_000 } }))
      .resolves.toMatchObject({ vatCents: 30_000 })
  })

  it("releasedAt is set once: never cleared, never moved", async () => {
    const row = await asset("TESTREL1")
    await database().financedAsset.update({ where: { id: row.id }, data: { releasedAt: new Date("2026-10-01T00:00:00Z") } })
    expect(await refusal(() => database().financedAsset.update({ where: { id: row.id }, data: { releasedAt: null } })))
      .toContain("A released asset stays released")
    expect(await refusal(() => database().financedAsset.update({ where: { id: row.id }, data: { releasedAt: new Date() } })))
      .toContain("A released asset stays released")
  })
})
