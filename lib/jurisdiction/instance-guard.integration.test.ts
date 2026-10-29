/**
 * Real-Postgres proof that one instance serves one jurisdiction (migration
 * 20261029110000_jurisdiction_instance_guard). Runs in its own throwaway
 * database: the rule is about every ACTIVE tenant of the database, and the
 * shared integration database holds hundreds of ZA tenants.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/jurisdiction/instance-guard.integration.test.ts
 *
 * The role needs CREATEDB (as prisma/seed.integration.test.ts does).
 */
import { execFileSync } from "node:child_process"
import { randomBytes } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { afterAll, beforeAll, describe, expect, it } from "vitest"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const REFUSED = /One instance serves one jurisdiction/

suite("one jurisdiction per instance (real DB)", () => {
  let admin: PrismaClient
  let db: PrismaClient
  let dbName = ""

  beforeAll(async () => {
    admin = new PrismaClient()
    dbName = `jur_it_${randomBytes(6).toString("hex")}`
    await admin.$executeRawUnsafe(`CREATE DATABASE "${dbName}"`)
    const url = new URL(process.env.DATABASE_URL ?? "")
    url.pathname = `/${dbName}`
    execFileSync("npx", ["prisma", "migrate", "deploy"], {
      cwd: process.cwd(), env: { ...process.env, DATABASE_URL: url.toString() }, stdio: ["ignore", "pipe", "pipe"],
    })
    db = new PrismaClient({ datasources: { db: { url: url.toString() } } })
  }, 240_000)

  afterAll(async () => {
    await db?.$disconnect()
    await admin?.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
    await admin?.$disconnect()
  })

  const lender = (slug: string, status: "ACTIVE" | "SUSPENDED", jurisdiction: "ZA" | "LS", currency: "ZAR" | "LSL") =>
    db.tenant.create({ data: { slug, name: slug, status, config: { create: { jurisdiction, currency } } } })

  it("lets the first lender in, and a second that agrees", async () => {
    await lender("ls-one", "ACTIVE", "LS", "LSL")
    await lender("ls-two", "ACTIVE", "LS", "LSL")
  })

  it("refuses a ZA lender created ACTIVE beside them, in either order of writes", async () => {
    await expect(lender("za-new", "ACTIVE", "ZA", "ZAR")).rejects.toThrow(REFUSED)
    // The tenant row first, its config second: the config insert is where it is caught.
    await expect(db.$transaction(async (tx) => {
      const t = await tx.tenant.create({ data: { slug: "za-split", name: "za-split", status: "ACTIVE" } })
      await tx.tenantConfig.create({ data: { tenantId: t.id } })
    })).rejects.toThrow(REFUSED)
    expect(await db.tenant.count({ where: { slug: { in: ["za-new", "za-split"] } } })).toBe(0)
  })

  it("accepts a ZA lender that is not ACTIVE, and refuses to activate or reactivate it", async () => {
    const za = await lender("za-parked", "SUSPENDED", "ZA", "ZAR")
    await expect(db.tenant.update({ where: { id: za.id }, data: { status: "ACTIVE" } })).rejects.toThrow(REFUSED)
    const provisioning = await db.tenant.create({ data: { slug: "za-prov", name: "za-prov", status: "PROVISIONING", config: { create: {} } } })
    await expect(db.tenant.update({ where: { id: provisioning.id }, data: { status: "ACTIVE" } })).rejects.toThrow(REFUSED)
  })

  it("refuses a different currency on the same jurisdiction", async () => {
    await expect(lender("ls-rand", "ACTIVE", "LS", "ZAR")).rejects.toThrow(REFUSED)
  })

  it("refuses to change an ACTIVE lender's jurisdiction or currency away from the others", async () => {
    const one = await db.tenant.findUniqueOrThrow({ where: { slug: "ls-one" } })
    await expect(db.tenantConfig.update({ where: { tenantId: one.id }, data: { currency: "ZAR" } })).rejects.toThrow(REFUSED)
    await expect(db.tenantConfig.update({ where: { tenantId: one.id }, data: { jurisdiction: "ZA", currency: "ZAR" } })).rejects.toThrow(REFUSED)
  })

  it("refuses to move a ZA config onto an ACTIVE tenant", async () => {
    const parked = await db.tenant.findUniqueOrThrow({ where: { slug: "za-parked" } })
    const bare = await db.tenant.create({ data: { slug: "ls-bare", name: "ls-bare", status: "ACTIVE" } })
    await expect(db.tenantConfig.update({ where: { tenantId: parked.id }, data: { tenantId: bare.id } })).rejects.toThrow()
  })

  it("lets a suspended lender be changed freely, then back to agreeing", async () => {
    const parked = await db.tenant.findUniqueOrThrow({ where: { slug: "za-parked" } })
    await db.tenantConfig.update({ where: { tenantId: parked.id }, data: { jurisdiction: "LS", currency: "LSL" } })
    await db.tenant.update({ where: { id: parked.id }, data: { status: "ACTIVE" } })
  })

  it("is not stopped by a strict-RLS session that shows the guard no rows", async () => {
    await expect(db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', 'some-other-tenant', true)`
      await tx.$executeRawUnsafe(`INSERT INTO "Tenant" ("id","slug","name","status","updatedAt") VALUES ('rls-za','rls-za','rls-za','PROVISIONING', now())`)
      await tx.$executeRawUnsafe(`INSERT INTO "TenantConfig" ("id","tenantId","updatedAt") VALUES ('rls-za-cfg','rls-za', now())`)
      await tx.$executeRawUnsafe(`UPDATE "Tenant" SET "status" = 'ACTIVE' WHERE "id" = 'rls-za'`)
    })).rejects.toThrow(REFUSED)
  })
})
