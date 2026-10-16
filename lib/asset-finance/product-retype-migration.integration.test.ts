/**
 * Real-Postgres proof for 20261016210000_retype_asset_finance_products on a
 * database seeded the way main seeded it: the demo seed's asset-finance deals
 * on products typed PERSONAL (as before the product kind existed). After the
 * migration every product used by an asset-finance deal is ASSET_FINANCE, the
 * consumer products keep their types, and a product with consumer history is
 * never re-typed, even under an asset-finance code.
 *
 * Self-contained: creates its own throwaway database on the server
 * DATABASE_URL points at, so the role needs CREATEDB.
 *
 *   RUN_ASSET_FINANCE_MIGRATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/product-retype-migration.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_ASSET_FINANCE_MIGRATION_IT === "1"
const suite = RUN ? describe : describe.skip
const MIGRATION = "20261016210000_retype_asset_finance_products"
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations")

/** A Prisma schema whose migrations directory holds every migration before MIGRATION. */
function schemaBefore(root: string): string {
  const dir = fs.mkdtempSync(path.join(root, "before-"))
  fs.writeFileSync(path.join(dir, "schema.prisma"), 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n')
  fs.mkdirSync(path.join(dir, "migrations"))
  fs.copyFileSync(path.join(MIGRATIONS_DIR, "migration_lock.toml"), path.join(dir, "migrations", "migration_lock.toml"))
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    if (fs.statSync(path.join(MIGRATIONS_DIR, name)).isDirectory() && name < MIGRATION) {
      fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(dir, "migrations", name), { recursive: true })
    }
  }
  return path.join(dir, "schema.prisma")
}

const run = (cmd: string, args: string[], url: string) =>
  execFileSync(cmd, args, { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })

suite("re-typing existing asset-finance products (migration on seeded data)", () => {
  const admin = RUN ? new PrismaClient() : null
  const name = `af_retype_it_${randomBytes(6).toString("hex")}`
  let root = ""
  let dbUrl = ""
  let db: PrismaClient | null = null
  const database = () => {
    if (!db) throw new Error("RUN_ASSET_FINANCE_MIGRATION_IT=1 is required")
    return db
  }

  beforeAll(async () => {
    if (!admin) throw new Error("RUN_ASSET_FINANCE_MIGRATION_IT=1 is required")
    root = fs.mkdtempSync(path.join(os.tmpdir(), "af-retype-migration-"))
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
    const url = new URL(process.env.DATABASE_URL ?? "")
    url.pathname = `/${name}`
    dbUrl = url.toString()
    run("npx", ["prisma", "migrate", "deploy", "--schema", schemaBefore(root)], dbUrl)
    run("npm", ["run", "seed:base", "--silent"], dbUrl)
    db = new PrismaClient({ datasources: { db: { url: dbUrl } } })
    // The state main left: no product kind, so the seed's asset-finance products were PERSONAL.
    await db.$executeRawUnsafe(`UPDATE "LoanProduct" SET "productType" = 'PERSONAL' WHERE "productType" = 'ASSET_FINANCE'`)
    // A second lender whose "AF-IS" product carries a consumer application: consumer history is never re-typed.
    await db.$executeRawUnsafe(`INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('tenant_retype', 'tenant-retype', 'Synthetic lender', CURRENT_TIMESTAMP)`)
    await db.$executeRawUnsafe(`
      INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount", "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
      VALUES ('product_retype', 'tenant_retype', 'AF-IS', 'Synthetic consumer product', 'PERSONAL', 100, 10000000, 30, 365, 0.03, 'DAILY_ACCRUAL')`)
    await db.$executeRawUnsafe(`
      INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
      VALUES ('client_retype', 'tenant_retype', 'CLI-RETYPE-1', 'ID-RETYPE-1', 'Synthetic', 'Borrower', 'retype@test.invalid', '+27820000000', CURRENT_TIMESTAMP)`)
    await db.$executeRawUnsafe(`
      INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays", "updatedAt")
      VALUES ('app_retype', 'tenant_retype', 'APP-RETYPE-1', 'client_retype', 'product_retype', 500000, 90, CURRENT_TIMESTAMP)`)
  }, 300_000)

  afterAll(async () => {
    await db?.$disconnect()
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin?.$disconnect()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it("re-types the products of asset-finance deals, and only those", async () => {
    const types = async () => Object.fromEntries((await database().$queryRawUnsafe<Array<{ tenantId: string; code: string; type: string }>>(
      `SELECT "tenantId", "code", "productType"::text AS type FROM "LoanProduct" ORDER BY "tenantId", "code"`,
    )).map((r) => [`${r.tenantId === "tenant_retype" ? "other:" : ""}${r.code}`, r.type]))
    const before = await types()
    expect(before["AF-IS"]).toBe("PERSONAL")
    expect(before["AF-LEASE"]).toBe("PERSONAL")
    const dealProductsBefore = await database().$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(DISTINCT a."productId") AS n FROM "LoanApplication" a JOIN "AssetFinanceDeal" d ON d."applicationId" = a."id"`)
    expect(Number(dealProductsBefore[0].n)).toBeGreaterThanOrEqual(2)

    run("npx", ["prisma", "migrate", "deploy"], dbUrl)

    const after = await types()
    expect(after["AF-IS"]).toBe("ASSET_FINANCE")
    expect(after["AF-LEASE"]).toBe("ASSET_FINANCE")
    expect(after["other:AF-IS"]).toBe("PERSONAL")
    for (const [code, type] of Object.entries(before)) {
      if (code !== "AF-IS" && code !== "AF-LEASE") expect([code, after[code]]).toEqual([code, type])
    }
    const stillConsumer = await database().$queryRawUnsafe<Array<{ n: bigint }>>(`
      SELECT count(*) AS n FROM "LoanApplication" a JOIN "AssetFinanceDeal" d ON d."applicationId" = a."id"
      JOIN "LoanProduct" p ON p."id" = a."productId" WHERE p."productType" <> 'ASSET_FINANCE'`)
    expect(Number(stillConsumer[0].n)).toBe(0)
  }, 180_000)
})
