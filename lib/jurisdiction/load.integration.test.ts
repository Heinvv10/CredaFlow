/**
 * Real-Postgres proof of the jurisdiction columns: a TenantConfig written with
 * no jurisdiction reads back ZA / ZAR (what every existing row became), the
 * enums refuse any other code, and the loader adopts a stored LS / LSL.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/jurisdiction/load.integration.test.ts
 */
import { PrismaClient } from "@prisma/client"
import { randomUUID } from "node:crypto"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { activeCurrency, activeJurisdiction, resetActiveJurisdiction } from "./active"
import { loadActiveJurisdiction } from "./load.server"

const suite = process.env.RUN_DB_IT === "1" ? describe : describe.skip
const db = new PrismaClient()

suite("jurisdiction columns and loader (real DB)", () => {
  const slug = `jurisdiction-it-${randomUUID()}`
  let tenantId = ""

  beforeAll(async () => {
    tenantId = (await db.tenant.create({ data: { slug, name: "Jurisdiction IT" } })).id
    await db.tenantConfig.create({ data: { tenantId } })
  })

  afterEach(() => resetActiveJurisdiction())

  afterAll(async () => {
    await db.tenantConfig.deleteMany({ where: { tenantId } })
    await db.tenant.delete({ where: { id: tenantId } })
    await db.$disconnect()
  })

  it("defaults a new config to ZA and the rand", async () => {
    const row = await db.tenantConfig.findUniqueOrThrow({ where: { tenantId }, select: { jurisdiction: true, currency: true } })
    expect(row).toEqual({ jurisdiction: "ZA", currency: "ZAR" })
  })

  it("refuses a jurisdiction the enum does not list", async () => {
    await expect(db.$executeRawUnsafe(`UPDATE "TenantConfig" SET "jurisdiction" = 'US' WHERE "tenantId" = '${tenantId}'`)).rejects.toThrow()
  })

  it("loads a stored LS / LSL for the tenant named by the slug env", async () => {
    await db.tenantConfig.update({ where: { tenantId }, data: { jurisdiction: "LS", currency: "LSL" } })
    const previous = process.env.NEXT_PUBLIC_TENANT_SLUG
    process.env.NEXT_PUBLIC_TENANT_SLUG = slug
    try {
      await loadActiveJurisdiction(db as unknown as Parameters<typeof loadActiveJurisdiction>[0])
      expect(activeJurisdiction()).toBe("LS")
      expect(activeCurrency()).toBe("LSL")
    } finally {
      if (previous === undefined) delete process.env.NEXT_PUBLIC_TENANT_SLUG
      else process.env.NEXT_PUBLIC_TENANT_SLUG = previous
    }
  })
})
