/**
 * Real-Postgres proof for 20261013090000_asset_finance_foundation on a
 * database that already holds consumer loans: every existing Loan backfills
 * to ncaRegime NCA / contractType LOAN, keeps its clientId, and the borrower
 * CHECKs validate against those rows.
 *
 * Self-contained: creates its own throwaway database (af_mig_it_<hex>) on the
 * server DATABASE_URL points at, so the role needs CREATEDB.
 *
 *   RUN_ASSET_FINANCE_MIGRATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/asset-finance/foundation-migration.integration.test.ts
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
const MIGRATION = "20261013090000_asset_finance_foundation"
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations")

/** A Prisma schema whose migrations directory holds every migration before MIGRATION, and MIGRATION itself if `inclusive`. */
function schemaWithMigrations(root: string, inclusive: boolean): string {
  const dir = fs.mkdtempSync(path.join(root, inclusive ? "through-" : "before-"))
  fs.writeFileSync(
    path.join(dir, "schema.prisma"),
    'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
  )
  fs.mkdirSync(path.join(dir, "migrations"))
  fs.copyFileSync(path.join(MIGRATIONS_DIR, "migration_lock.toml"), path.join(dir, "migrations", "migration_lock.toml"))
  for (const name of fs.readdirSync(MIGRATIONS_DIR)) {
    if (!fs.statSync(path.join(MIGRATIONS_DIR, name)).isDirectory()) continue
    if (name < MIGRATION || (inclusive && name === MIGRATION)) {
      fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(dir, "migrations", name), { recursive: true })
    }
  }
  return path.join(dir, "schema.prisma")
}

function prismaCli(url: string, args: string[]): string {
  return execFileSync("npx", ["prisma", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, DATABASE_URL: url },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  })
}

/** Two consumer loans written the way the pre-migration code wrote them. */
async function seedConsumerLoans(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('tenant_mig', 'tenant-mig', 'Synthetic lender', CURRENT_TIMESTAMP);
  `)
  await db.$executeRawUnsafe(`
    INSERT INTO "LoanProduct" ("id", "tenantId", "code", "name", "productType", "minAmount", "maxAmount",
      "minTermDays", "maxTermDays", "interestRatePm", "interestModel")
    VALUES ('product_mig', 'tenant_mig', 'MIG', 'Synthetic product', 'PERSONAL', 100, 10000000, 30, 365, 0.03, 'DAILY_ACCRUAL');
  `)
  for (const n of [1, 2]) {
    await db.$executeRawUnsafe(`
      INSERT INTO "Client" ("id", "tenantId", "reference", "idNumber", "firstName", "lastName", "email", "phone", "updatedAt")
      VALUES ('client_mig_${n}', 'tenant_mig', 'CLI-MIG-${n}', 'ID-MIG-${n}', 'Synthetic', 'Borrower${n}',
        'mig-${n}@test.invalid', '+27820000000', CURRENT_TIMESTAMP);
    `)
    await db.$executeRawUnsafe(`
      INSERT INTO "LoanApplication" ("id", "tenantId", "reference", "clientId", "productId", "appliedAmount", "appliedTermDays", "updatedAt")
      VALUES ('app_mig_${n}', 'tenant_mig', 'APP-MIG-${n}', 'client_mig_${n}', 'product_mig', 500000, 90, CURRENT_TIMESTAMP);
    `)
    await db.$executeRawUnsafe(`
      INSERT INTO "Loan" ("id", "tenantId", "reference", "applicationId", "clientId", "productId", "principal",
        "totalInterest", "initiationFee", "totalRepayable", "outstandingPrincipal", "startDate", "maturityDate",
        "interestRatePm", "interestModel", "updatedAt")
      VALUES ('loan_mig_${n}', 'tenant_mig', 'LN-MIG-${n}', 'app_mig_${n}', 'client_mig_${n}', 'product_mig', 500000,
        10000, 0, 510000, 500000, TIMESTAMP '2026-09-01', TIMESTAMP '2026-12-01', 0.03, 'DAILY_ACCRUAL', CURRENT_TIMESTAMP);
    `)
  }
}

suite("asset finance foundation migration on existing consumer data", () => {
  const admin = RUN ? new PrismaClient() : null
  const created: string[] = []
  const open: PrismaClient[] = []
  let root = ""
  let before = ""
  let through = ""

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "af-foundation-migration-"))
    before = schemaWithMigrations(root, false)
    through = schemaWithMigrations(root, true)
  })

  afterAll(async () => {
    for (const prisma of open) await prisma.$disconnect()
    for (const name of created) await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin?.$disconnect()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it("backfills existing loans to NCA / LOAN with their client, and validates the borrower CHECKs", async () => {
    if (!admin) throw new Error("RUN_ASSET_FINANCE_MIGRATION_IT=1 is required")
    const name = `af_mig_it_${randomBytes(6).toString("hex")}`
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
    created.push(name)
    const url = new URL(process.env.DATABASE_URL ?? "")
    url.pathname = `/${name}`
    prismaCli(url.toString(), ["migrate", "deploy", "--schema", before])
    const db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    open.push(db)
    await seedConsumerLoans(db)

    prismaCli(url.toString(), ["migrate", "deploy", "--schema", through])

    expect(await db.$queryRawUnsafe(
      `SELECT "id", "clientId", "entityId", "ncaRegime"::text AS regime, "contractType"::text AS "contractType", "balloonAmount"
       FROM "Loan" ORDER BY "id"`,
    )).toEqual([
      { id: "loan_mig_1", clientId: "client_mig_1", entityId: null, regime: "NCA", contractType: "LOAN", balloonAmount: null },
      { id: "loan_mig_2", clientId: "client_mig_2", entityId: null, regime: "NCA", contractType: "LOAN", balloonAmount: null },
    ])
    expect(await db.$queryRawUnsafe(
      `SELECT "id", "clientId", "entityId", "ncaRegime"::text AS regime FROM "LoanApplication" ORDER BY "id"`,
    )).toEqual([
      { id: "app_mig_1", clientId: "client_mig_1", entityId: null, regime: null },
      { id: "app_mig_2", clientId: "client_mig_2", entityId: null, regime: null },
    ])
    expect(await db.$queryRawUnsafe(
      `SELECT conname, convalidated FROM pg_constraint
       WHERE conname IN ('Loan_borrower_xor', 'LoanApplication_borrower_xor', 'Loan_non_nca_requires_entity')
       ORDER BY conname`,
    )).toEqual([
      { conname: "LoanApplication_borrower_xor", convalidated: true },
      { conname: "Loan_borrower_xor", convalidated: true },
      { conname: "Loan_non_nca_requires_entity", convalidated: true },
    ])
  }, 180_000)
})
