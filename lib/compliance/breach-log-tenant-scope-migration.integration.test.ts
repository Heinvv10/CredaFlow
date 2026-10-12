/**
 * Real-Postgres proof for 20261011070000_breach_log_tenant_scope: the
 * migration that gives BreachLog a required tenantId.
 *
 * Self-contained: each case creates its own throwaway database
 * (breach_mig_it_<hex>) on the server DATABASE_URL points at, applies the
 * migrations BEFORE this one, seeds the state under test, then applies this
 * one through `prisma migrate deploy` (the path a deployment takes). The role
 * in DATABASE_URL therefore needs CREATEDB.
 *
 *   RUN_BREACH_LOG_MIGRATION_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/compliance/breach-log-tenant-scope-migration.integration.test.ts
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const RUN = process.env.RUN_BREACH_LOG_MIGRATION_IT === "1"
const suite = RUN ? describe : describe.skip
const MIGRATION = "20261011070000_breach_log_tenant_scope"
const MIGRATIONS_DIR = path.join(process.cwd(), "prisma", "migrations")

type ScratchDb = { url: string; prisma: PrismaClient }

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

/** Everything a CLI run that must fail printed; throws if it succeeded. */
function failedOutput(fn: () => unknown): string {
  try {
    fn()
  } catch (error) {
    const e = error as { stdout?: unknown; stderr?: unknown }
    return `${String(e.stdout ?? "")}\n${String(e.stderr ?? "")}`
  }
  throw new Error("expected the migration to fail, but it applied")
}

const tenantIdColumn = (db: PrismaClient) => db.$queryRawUnsafe<Array<{ is_nullable: string }>>(
  `SELECT is_nullable FROM information_schema.columns WHERE table_name = 'BreachLog' AND column_name = 'tenantId'`,
)
// Whole rows as jsonb: a `SELECT *` prepared before the migration cannot be
// re-run after it ("cached plan must not change result type").
const rowsOf = (table: string) => async (db: PrismaClient) =>
  (await db.$queryRawUnsafe<Array<{ row: Record<string, unknown> }>>(
    `SELECT to_jsonb(t) AS row FROM "${table}" t ORDER BY t."id"`,
  )).map((r) => r.row)
const breachRows = rowsOf("BreachLog")
const tenantRows = rowsOf("Tenant")

async function seedTenants(db: PrismaClient, ids: string[]) {
  for (const id of ids) {
    await db.$executeRawUnsafe(
      `INSERT INTO "Tenant" ("id", "slug", "name", "updatedAt") VALUES ('${id}', '${id}', 'Synthetic lender ${id}', CURRENT_TIMESTAMP)`,
    )
  }
}
/** Two register rows written the way the pre-migration code wrote them: no tenant. */
async function seedBreaches(db: PrismaClient) {
  await db.$executeRawUnsafe(`
    INSERT INTO "BreachLog" ("id", "incidentDate", "discoveredDate", "description", "affectedClients", "dataCategories", "status", "createdBy", "updatedAt")
    VALUES
      ('breach_one', TIMESTAMP '2026-09-01 00:00:00', TIMESTAMP '2026-09-02 00:00:00', 'Synthetic incident one.', 4, 'Contact details', 'OPEN', 'staff_one', TIMESTAMP '2026-09-02 08:00:00'),
      ('breach_two', TIMESTAMP '2026-09-05 00:00:00', TIMESTAMP '2026-09-06 00:00:00', 'Synthetic incident two.', 0, 'Bank details', 'CONTAINED', NULL, TIMESTAMP '2026-09-06 08:00:00')
  `)
}

suite("breach log tenant-scope migration", () => {
  const admin = RUN ? new PrismaClient() : null
  const created: string[] = []
  const open: PrismaClient[] = []
  let root = ""
  let before = ""
  let through = ""

  /** Creates breach_mig_it_<hex> and applies the migrations before this one. */
  async function scratchDb(): Promise<ScratchDb> {
    if (!admin) throw new Error("RUN_BREACH_LOG_MIGRATION_IT=1 is required")
    const name = `breach_mig_it_${randomBytes(6).toString("hex")}`
    await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`)
    created.push(name)
    const url = new URL(process.env.DATABASE_URL ?? "")
    url.pathname = `/${name}`
    prismaCli(url.toString(), ["migrate", "deploy", "--schema", before])
    const prisma = new PrismaClient({ datasources: { db: { url: url.toString() } } })
    open.push(prisma)
    expect(await tenantIdColumn(prisma)).toEqual([])
    return { url: url.toString(), prisma }
  }
  const applyThisMigration = (db: ScratchDb) => prismaCli(db.url, ["migrate", "deploy", "--schema", through])

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "breach-log-migration-"))
    before = schemaWithMigrations(root, false)
    through = schemaWithMigrations(root, true)
  })

  afterAll(async () => {
    for (const prisma of open) await prisma.$disconnect()
    for (const name of created) await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`)
    await admin?.$disconnect()
    if (root) fs.rmSync(root, { recursive: true, force: true })
  })

  it("applies to a database with no breach rows, leaving a required, indexed tenantId with a foreign key", async () => {
    const db = await scratchDb()
    await seedTenants(db.prisma, ["tenant_a", "tenant_b"])
    applyThisMigration(db)

    expect(await tenantIdColumn(db.prisma)).toEqual([{ is_nullable: "NO" }])
    expect(await db.prisma.$queryRawUnsafe(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conname = 'BreachLog_tenantId_fkey'`,
    )).toEqual([{ def: 'FOREIGN KEY ("tenantId") REFERENCES "Tenant"(id) ON UPDATE CASCADE ON DELETE RESTRICT' }])
    expect(await db.prisma.$queryRawUnsafe(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'BreachLog_tenantId_idx'`,
    )).toEqual([{ indexdef: 'CREATE INDEX "BreachLog_tenantId_idx" ON public."BreachLog" USING btree ("tenantId")' }])

    const insert = (tenant: string) => db.prisma.$executeRawUnsafe(`
      INSERT INTO "BreachLog" ("id", "tenantId", "incidentDate", "discoveredDate", "description", "dataCategories", "updatedAt")
      VALUES ('breach_new', ${tenant}, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'Synthetic incident.', 'Contact details', CURRENT_TIMESTAMP)
    `)
    // 23502 not_null_violation, 23503 foreign_key_violation.
    await expect(insert("NULL")).rejects.toThrow(/Code: `23502`/)
    await expect(insert("'tenant_missing'")).rejects.toThrow(/Code: `23503`/)
    expect(await insert("'tenant_a'")).toBe(1)
  }, 120_000)

  it("leaves the full migration history in step with schema.prisma", async () => {
    const db = await scratchDb()
    prismaCli(db.url, ["migrate", "deploy"])
    // --exit-code: 0 when the migrated database and the schema agree, 2 when they differ.
    expect(prismaCli(db.url, [
      "migrate", "diff", "--from-url", db.url, "--to-schema-datamodel", "prisma/schema.prisma", "--exit-code",
    ])).toContain("No difference detected")
  }, 120_000)

  it("assigns existing breach rows to the tenant when the database has exactly one", async () => {
    const db = await scratchDb()
    await seedTenants(db.prisma, ["tenant_only"])
    await seedBreaches(db.prisma)
    const rowsBefore = await breachRows(db.prisma)
    const tenantsBefore = await tenantRows(db.prisma)

    applyThisMigration(db)

    expect(await breachRows(db.prisma)).toEqual(rowsBefore.map((row) => ({ ...row, tenantId: "tenant_only" })))
    expect(await tenantRows(db.prisma)).toEqual(tenantsBefore)
    expect(await tenantIdColumn(db.prisma)).toEqual([{ is_nullable: "NO" }])
  }, 120_000)

  it("fails loudly with two tenants, changes nothing, and applies once every row is assigned by hand", async () => {
    const db = await scratchDb()
    await seedTenants(db.prisma, ["tenant_a", "tenant_b"])
    await seedBreaches(db.prisma)
    const rowsBefore = await breachRows(db.prisma)

    const output = failedOutput(() => applyThisMigration(db))
    expect(output).toContain("BreachLog has 2 row(s) without a tenant and this database has 2 tenants")
    expect(output).toContain("Assign each row by hand")
    // The migration is one transaction: no column, and the rows as they were.
    expect(await tenantIdColumn(db.prisma)).toEqual([])
    expect(await breachRows(db.prisma)).toEqual(rowsBefore)
    expect(await db.prisma.$queryRawUnsafe(
      `SELECT count(*)::int AS failed FROM "_prisma_migrations" WHERE migration_name = '${MIGRATION}' AND finished_at IS NULL`,
    )).toEqual([{ failed: 1 }])

    // Assigning only some rows is still refused.
    await db.prisma.$executeRawUnsafe(`ALTER TABLE "BreachLog" ADD COLUMN IF NOT EXISTS "tenantId" TEXT`)
    await db.prisma.$executeRawUnsafe(`UPDATE "BreachLog" SET "tenantId" = 'tenant_b' WHERE "id" = 'breach_one'`)
    prismaCli(db.url, ["migrate", "resolve", "--rolled-back", MIGRATION, "--schema", through])
    expect(failedOutput(() => applyThisMigration(db)))
      .toContain("BreachLog has 1 row(s) without a tenant and this database has 2 tenants")

    // The recovery the message describes.
    await db.prisma.$executeRawUnsafe(`UPDATE "BreachLog" SET "tenantId" = 'tenant_a' WHERE "id" = 'breach_two'`)
    prismaCli(db.url, ["migrate", "resolve", "--rolled-back", MIGRATION, "--schema", through])
    applyThisMigration(db)

    expect(await breachRows(db.prisma)).toEqual([
      { ...rowsBefore[0], tenantId: "tenant_b" },
      { ...rowsBefore[1], tenantId: "tenant_a" },
    ])
    expect(await tenantIdColumn(db.prisma)).toEqual([{ is_nullable: "NO" }])
  }, 180_000)

  it("fails loudly with breach rows and no tenant at all, changing nothing", async () => {
    const db = await scratchDb()
    await seedBreaches(db.prisma)
    const rowsBefore = await breachRows(db.prisma)

    expect(failedOutput(() => applyThisMigration(db)))
      .toContain("BreachLog has 2 row(s) without a tenant and this database has 0 tenants")
    expect(await tenantIdColumn(db.prisma)).toEqual([])
    expect(await breachRows(db.prisma)).toEqual(rowsBefore)
  }, 120_000)
})
