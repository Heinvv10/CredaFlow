/**
 * Real-Postgres proof that one instance serves one jurisdiction (migration
 * 20261029120000_instance_jurisdiction): InstanceJurisdiction is a single,
 * immutable-after-loans row; every lender's TenantConfig must equal it; the
 * app reads it; and the writer is audited and refused once loans exist.
 *
 * Each suite runs in its own throwaway database: the rule is about the whole
 * database, and the shared integration database holds hundreds of ZA lenders.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/jurisdiction/instance-guard.integration.test.ts
 *
 * The role needs CREATEDB (as prisma/seed.integration.test.ts does).
 */
import { readFileSync } from "node:fs"
import { PrismaClient } from "@prisma/client"
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { resetActiveJurisdiction, activeCurrency, activeJurisdiction } from "./active"
import { setInstanceJurisdiction } from "./instance-write"
import { loadActiveJurisdiction, resetEnsuredJurisdiction } from "./load.server"
import { bootstrapTenant } from "@/scripts/lender/bootstrap-tenant"
import { parseTenantConfig } from "@/scripts/lender/tenant-config"
import { validFile } from "@/scripts/lender/tenant-config.test-helpers"
import { createThrowawayDb, type ThrowawayDb } from "./throwaway-db.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const REFUSED = /One instance serves one jurisdiction/
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

suite("a Lesotho instance (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: { jurisdiction: "LS", currency: "LSL" } })
  }, 240_000)
  afterAll(() => fresh?.drop())
  afterEach(() => { resetActiveJurisdiction(); resetEnsuredJurisdiction() })

  const lender = (slug: string, status: "ACTIVE" | "SUSPENDED" | "PROVISIONING", config: { jurisdiction: "ZA" | "LS"; currency: "ZAR" | "LSL" }) =>
    db().tenant.create({ data: { slug, name: slug, status, config: { create: config } } })
  const LS = { jurisdiction: "LS", currency: "LSL" } as const

  it("accepts a lender that equals the instance, in any status", async () => {
    await lender("ls-active", "ACTIVE", LS)
    await lender("ls-prov", "PROVISIONING", LS)
    await lender("ls-parked", "SUSPENDED", LS)
  })

  it("refuses a lender whose config differs, whatever its status and however it is written", async () => {
    await expect(lender("za-active", "ACTIVE", { jurisdiction: "ZA", currency: "ZAR" })).rejects.toThrow(REFUSED)
    await expect(lender("za-prov", "PROVISIONING", { jurisdiction: "ZA", currency: "ZAR" })).rejects.toThrow(REFUSED)
    await expect(lender("za-parked", "SUSPENDED", { jurisdiction: "ZA", currency: "ZAR" })).rejects.toThrow(REFUSED)
    await expect(lender("ls-rand", "ACTIVE", { jurisdiction: "LS", currency: "ZAR" })).rejects.toThrow(REFUSED)
    // Tenant row first, config second: the config insert is where it is caught.
    await expect(db().$transaction(async (tx) => {
      const t = await tx.tenant.create({ data: { slug: "za-split", name: "za-split", status: "ACTIVE" } })
      await tx.tenantConfig.create({ data: { tenantId: t.id } })
    })).rejects.toThrow(REFUSED)
    expect(await db().tenant.count({ where: { slug: { startsWith: "za-" } } })).toBe(0)
  })

  it("refuses to change a lender's config away from the instance, and to move a config onto another tenant", async () => {
    const one = await db().tenant.findUniqueOrThrow({ where: { slug: "ls-active" } })
    await expect(db().tenantConfig.update({ where: { tenantId: one.id }, data: { currency: "ZAR" } })).rejects.toThrow(REFUSED)
    await expect(db().tenantConfig.update({ where: { tenantId: one.id }, data: { jurisdiction: "ZA", currency: "ZAR" } })).rejects.toThrow(REFUSED)
  })

  it("refuses to bring a tenant with a stale, mismatching config into service (ACTIVE or PROVISIONING), but lets it be suspended", async () => {
    const parked = await db().tenant.findUniqueOrThrow({ where: { slug: "ls-parked" } })
    // A legacy mismatch the config triggers would never allow: written with triggers off, as a restore or a bug could.
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`UPDATE "TenantConfig" SET "jurisdiction" = 'ZA', "currency" = 'ZAR' WHERE "tenantId" = '${parked.id}'`)
    })
    await expect(db().tenant.update({ where: { id: parked.id }, data: { status: "ACTIVE" } })).rejects.toThrow(REFUSED)
    await expect(db().tenant.update({ where: { id: parked.id }, data: { status: "PROVISIONING" } })).rejects.toThrow(REFUSED)
    await db().tenant.update({ where: { id: parked.id }, data: { status: "SUSPENDED" } })
    // Put it right again, as an operator would.
    await db().tenantConfig.update({ where: { tenantId: parked.id }, data: { jurisdiction: "LS", currency: "LSL" } })
    await db().tenant.update({ where: { id: parked.id }, data: { status: "ACTIVE" } })
  })

  it("refuses to re-point a mismatching config at another tenant", async () => {
    const donor = await lender("ls-donor", "SUSPENDED", LS)
    const target = await db().tenant.create({ data: { slug: "ls-target", name: "ls-target", status: "SUSPENDED" } })
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`UPDATE "TenantConfig" SET "jurisdiction" = 'ZA', "currency" = 'ZAR' WHERE "tenantId" = '${donor.id}'`)
    })
    await expect(db().tenantConfig.update({ where: { tenantId: donor.id }, data: { tenantId: target.id } })).rejects.toThrow(REFUSED)
  })

  it("holds under a strict-RLS session that shows the guards no rows", async () => {
    await expect(db().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', 'some-other-tenant', true)`
      await tx.$executeRawUnsafe(`INSERT INTO "Tenant" ("id","slug","name","status","updatedAt") VALUES ('rls-za','rls-za','rls-za','PROVISIONING', now())`)
      await tx.$executeRawUnsafe(`INSERT INTO "TenantConfig" ("id","tenantId","updatedAt") VALUES ('rls-za-cfg','rls-za', now())`)
    })).rejects.toThrow(REFUSED)
  })

  it("the instance row is a singleton that cannot be deleted or truncated", async () => {
    await expect(db().$executeRawUnsafe(`INSERT INTO "InstanceJurisdiction" ("id","jurisdiction","currency") VALUES (2,'LS','LSL')`)).rejects.toThrow(/singleton/)
    await expect(db().instanceJurisdiction.delete({ where: { id: 1 } })).rejects.toThrow(/cannot be deleted/)
    await expect(db().$executeRawUnsafe(`TRUNCATE "InstanceJurisdiction"`)).rejects.toThrow(/cannot be truncated/)
    await expect(db().$executeRawUnsafe(`UPDATE "InstanceJurisdiction" SET "jurisdiction" = 'ZA', "currency" = 'LSL'`)).rejects.toThrow(/jurisdiction_currency/)
  })

  it("a change of the instance is refused while a lender still differs (the agreement check)", async () => {
    // The row alone, with LS/LSL lenders in place. (The check is deferred to commit; Prisma can swallow a
    // commit-time error, so the test, like the writer, forces it inside the transaction.)
    await expect(db().$transaction(async (tx) => {
      await tx.instanceJurisdiction.update({ where: { id: 1 }, data: { jurisdiction: "LS", currency: "ZAR" } })
      await tx.$executeRaw`SET CONSTRAINTS "InstanceJurisdiction_configs_agree" IMMEDIATE`
    })).rejects.toThrow(REFUSED)
    expect((await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).currency).toBe("LSL")
  })

  it("provisions a Lesotho lender through the operator bootstrap, with the instance's jurisdiction and no NCR number", async () => {
    await loadActiveJurisdiction(db() as never)
    const identity = {
      ...validFile().identity, legalName: "Demo Basotho Lending (Pty) Ltd", brandName: "Demo Basotho Lending",
      ncrNumber: null, fscaNumber: null, companyRegNumber: "2099/000001", registeredOffice: "1 Demo Road\nMaseru\n100",
      publicPhone: "+266 2200 0000", collectionsPhone: "+266 2200 0001",
    }
    const parsed = parseTenantConfig({
      ...validFile(), slug: "basotho-boot", name: identity.legalName, domain: "basotho-boot.example.test", identity,
      statutoryConfirm: { ncrNumber: null, fscaNumber: null, companyRegNumber: "2099/000001" },
    })
    if (!parsed.ok) throw new Error(parsed.errors.join("; "))
    expect((await bootstrapTenant(db(), parsed.config, { dryRun: false, operator: "it@host", seedTemplates: async () => {} })).status).toBe("created")
    expect(await db().tenantConfig.findFirstOrThrow({ where: { tenant: { slug: "basotho-boot" } } })).toMatchObject({ jurisdiction: "LS", currency: "LSL", ncrNumber: null })
  })

  it("the app loads the jurisdiction from the instance row", async () => {
    await loadActiveJurisdiction(db() as never)
    expect(activeJurisdiction()).toBe("LS")
    expect(activeCurrency()).toBe("LSL")
  })
})

suite("a South African instance (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  beforeAll(async () => { fresh = await createThrowawayDb() }, 240_000)
  afterAll(() => fresh?.drop())

  it("the migration leaves an empty database ZA / ZAR, set by the migration", async () => {
    expect(await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ jurisdiction: "ZA", currency: "ZAR", setBy: "migration" })
  })

  it("a config written with no jurisdiction reads back ZA / ZAR, and the enums refuse any other code", async () => {
    const t = await createChargesTenant(db(), false)
    expect(await db().tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId }, select: { jurisdiction: true, currency: true } })).toEqual({ jurisdiction: "ZA", currency: "ZAR" })
    await expect(db().$executeRawUnsafe(`UPDATE "TenantConfig" SET "jurisdiction" = 'US' WHERE "tenantId" = '${t.tenantId}'`)).rejects.toThrow()
  })

  it("refuses an LS lender; ZA lenders come in as they always did", async () => {
    await expect(db().tenant.create({ data: { slug: "ls-new", name: "x", status: "ACTIVE", config: { create: { jurisdiction: "LS", currency: "LSL" } } } })).rejects.toThrow(REFUSED)
    await createChargesTenant(db(), false)
  })

  it("an instance change that leaves a lender behind is refused; with the lenders moved in the same transaction it goes through", async () => {
    const t = await createChargesTenant(db(), false)
    await expect(db().$transaction(async (tx) => {
      await tx.instanceJurisdiction.update({ where: { id: 1 }, data: { jurisdiction: "LS", currency: "LSL" } })
      await tx.$executeRaw`SET CONSTRAINTS "InstanceJurisdiction_configs_agree" IMMEDIATE`
    })).rejects.toThrow(REFUSED)
    await db().$transaction(async (tx) => {
      await tx.instanceJurisdiction.update({ where: { id: 1 }, data: { jurisdiction: "LS", currency: "LSL" } })
      await tx.tenantConfig.updateMany({ data: { jurisdiction: "LS", currency: "LSL" } })
      await tx.$executeRaw`SET CONSTRAINTS "InstanceJurisdiction_configs_agree" IMMEDIATE`
    })
    expect((await db().tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).jurisdiction).toBe("LS")
  })
})

suite("the instance after its first loan (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  beforeAll(async () => { fresh = await createThrowawayDb() }, 240_000)
  afterAll(() => fresh?.drop())

  it("refuses an operator change, in the writer and in the database, and keeps the lender's configuration", async () => {
    const t = await createChargesTenant(db(), false)
    await createChargesLoan(db(), t)
    const result = await setInstanceJurisdiction(db(), { jurisdiction: "LS", currency: "LSL", actor: "ops@test.invalid", reason: "too late" })
    expect(result).toMatchObject({ ok: false, error: expect.stringMatching(/new instance/) })
    await expect(db().$transaction(async (tx) => {
      await tx.instanceJurisdiction.update({ where: { id: 1 }, data: { jurisdiction: "LS", currency: "LSL" } })
      await tx.tenantConfig.updateMany({ data: { jurisdiction: "LS", currency: "LSL" } })
    })).rejects.toThrow(/cannot change once any loan application or loan exists/)
    expect((await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).jurisdiction).toBe("ZA")
  })

  it("a lender's configuration cannot be deleted once it has loans; lenders are retired by status", async () => {
    const t = await createChargesTenant(db(), false)
    await createChargesLoan(db(), t)
    await expect(db().tenantConfig.delete({ where: { tenantId: t.tenantId } })).rejects.toThrow(/cannot be deleted once it has loan applications or loans/)
    await db().tenant.update({ where: { id: t.tenantId }, data: { status: "SUSPENDED" } })
  })

  it("a lender with no loans can have its configuration deleted", async () => {
    const t = await createChargesTenant(db(), false)
    await db().user.deleteMany({ where: { tenantId: t.tenantId } })
    await db().loanProduct.deleteMany({ where: { tenantId: t.tenantId } })
    await db().tenantConfig.delete({ where: { tenantId: t.tenantId } })
  })
})

suite("the operator writer (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  beforeAll(async () => { fresh = await createThrowawayDb() }, 240_000)
  afterAll(() => fresh?.drop())

  it("moves the instance and its lenders to Lesotho before any loan, and audits it", async () => {
    const t = await createChargesTenant(db(), false)
    const result = await setInstanceJurisdiction(db(), { jurisdiction: "LS", currency: "LSL", actor: "ops@test.invalid", reason: "Lesotho PostBank" })
    expect(result).toEqual({ ok: true, changed: true, jurisdiction: "LS", currency: "LSL" })
    expect(await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ jurisdiction: "LS", currency: "LSL", setBy: "ops@test.invalid" })
    expect((await db().tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).currency).toBe("LSL")
    const audit = await db().auditLog.findFirstOrThrow({ where: { action: "INSTANCE_JURISDICTION_SET" } })
    expect(audit).toMatchObject({ userEmail: "ops@test.invalid", entity: "InstanceJurisdiction" })
    expect(audit.newValue).toMatchObject({ jurisdiction: "LS", reason: "Lesotho PostBank", lendersMoved: 1 })
  })
})

suite("a tenant created while the instance is being changed (real DB)", () => {
  let fresh: ThrowawayDb
  let second: PrismaClient

  beforeAll(async () => {
    fresh = await createThrowawayDb()
    second = new PrismaClient({ datasources: { db: { url: fresh.url } } })
  }, 240_000)
  afterAll(async () => {
    await second?.$disconnect()
    await fresh?.drop()
  })

  it("waits for the change and then sees the new value (the advisory lock), instead of slipping a ZA lender in beside LS", async () => {
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    let instanceChanged: () => void = () => undefined
    const changed = new Promise<void>((resolve) => { instanceChanged = resolve })

    // Connection 1: the operator change, held open after it has written the row.
    const change = fresh.db.$transaction(async (tx) => {
      await tx.instanceJurisdiction.update({ where: { id: 1 }, data: { jurisdiction: "LS", currency: "LSL" } })
      instanceChanged()
      await held
    }, { timeout: 60_000 })

    await changed
    // Connection 2: a South African lender being created meanwhile.
    let finished = false
    const create = second.$transaction(async (tx) => {
      const t = await tx.tenant.create({ data: { slug: "za-race", name: "za-race", status: "ACTIVE" } })
      await tx.tenantConfig.create({ data: { tenantId: t.id, jurisdiction: "ZA", currency: "ZAR" } })
    }, { timeout: 60_000 }).finally(() => { finished = true })
    create.catch(() => undefined)

    await sleep(1_000)
    // It is waiting on the lock, not racing ahead on the old value.
    expect(finished, "the second transaction must wait for the instance change").toBe(false)
    release()
    await change
    await expect(create).rejects.toThrow(REFUSED)
    expect(await fresh.db.tenant.count({ where: { slug: "za-race" } })).toBe(0)
  }, 120_000)
})

suite("the migration's backfill (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  // The DO block of the migration, run again against lenders written with the triggers off
  // (as an upgraded database that predates the row would hold them).
  const backfill = readFileSync("prisma/migrations/20261029120000_instance_jurisdiction/migration.sql", "utf8").match(/DO \$backfill\$[^]*?\$backfill\$;/)?.[0] ?? ""
  const rerun = (setup: string[]) => db().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
    await tx.$executeRawUnsafe(`DELETE FROM "InstanceJurisdiction"`)
    await tx.$executeRawUnsafe(`DELETE FROM "TenantConfig"`)
    await tx.$executeRawUnsafe(`DELETE FROM "Tenant"`)
    for (const statement of setup) await tx.$executeRawUnsafe(statement)
    await tx.$executeRawUnsafe(backfill)
  })
  const lender = (slug: string, status: string, j: string, c: string) => [
    `INSERT INTO "Tenant" ("id","slug","name","status","updatedAt") VALUES ('${slug}','${slug}','${slug}','${status}', now())`,
    `INSERT INTO "TenantConfig" ("id","tenantId","jurisdiction","currency","updatedAt") VALUES ('${slug}-cfg','${slug}','${j}','${c}', now())`,
  ]

  beforeAll(async () => { fresh = await createThrowawayDb() }, 240_000)
  afterAll(() => fresh?.drop())

  it("found the backfill block in the migration", () => { expect(backfill).toContain("InstanceJurisdiction") })

  it("takes the value the ACTIVE lenders agree on, ignoring parked ones", async () => {
    await rerun([...lender("a-ls", "ACTIVE", "LS", "LSL"), ...lender("b-za", "SUSPENDED", "ZA", "ZAR")])
    expect(await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ jurisdiction: "LS", currency: "LSL", setBy: "migration" })
  })

  it("is ZA / ZAR with no lenders", async () => {
    await rerun([])
    expect(await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ jurisdiction: "ZA", currency: "ZAR" })
  })

  it("fails the migration when ACTIVE lenders disagree", async () => {
    await expect(rerun([...lender("a-ls", "ACTIVE", "LS", "LSL"), ...lender("b-za", "ACTIVE", "ZA", "ZAR")])).rejects.toThrow(/disagree/)
  })
})
