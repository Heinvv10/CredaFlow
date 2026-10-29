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
import { applyStaffAccessPolicy } from "@/lib/security/staff-access-write"
import { createChargesLoan, createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { resetActiveJurisdiction, activeCurrency, activeJurisdiction } from "./active"
import { setInstanceJurisdiction } from "./instance-write"
import { loadActiveJurisdiction, resetEnsuredJurisdiction } from "./load.server"
import { bootstrapTenant } from "@/scripts/lender/bootstrap-tenant"
import { parseTenantConfig } from "@/scripts/lender/tenant-config"
import { validFile } from "@/scripts/lender/tenant-config.test-helpers"
import { createThrowawayDb, type ThrowawayDb } from "./throwaway-db.integration-fixture"

const MIGRATION = "prisma/migrations/20261029120000_instance_jurisdiction/migration.sql"
const backfillBlock = () => readFileSync(MIGRATION, "utf8").match(/DO \$backfill\$[^]*?\$backfill\$;/)?.[0] ?? ""

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

  it("gives a new config the instance's values whatever it carried, however it is written", async () => {
    const za = { jurisdiction: "ZA", currency: "ZAR" } as const
    for (const [slug, status, config] of [
      ["za-active", "ACTIVE", za], ["za-prov", "PROVISIONING", za], ["za-parked", "SUSPENDED", za],
      ["ls-rand", "ACTIVE", { jurisdiction: "LS", currency: "ZAR" }],
    ] as const) {
      await lender(slug, status, config)
      expect(await db().tenantConfig.findFirstOrThrow({ where: { tenant: { slug } } })).toMatchObject(LS)
    }
    // Tenant row first, config second with the column defaults (ZA / ZAR): the default becomes the instance's.
    const split = await db().$transaction(async (tx) => {
      const t = await tx.tenant.create({ data: { slug: "za-split", name: "za-split", status: "ACTIVE" } })
      return tx.tenantConfig.create({ data: { tenantId: t.id } })
    })
    expect(split).toMatchObject(LS)
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
    // Put the legacy mismatch right: the app refuses to serve beside one (loadActiveJurisdiction).
    await db().tenantConfig.update({ where: { tenantId: donor.id }, data: { jurisdiction: "LS", currency: "LSL" } })
  })

  it("holds under a strict-RLS session that shows the guards no rows", async () => {
    const stale = await lender("ls-rls", "SUSPENDED", LS)
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`UPDATE "TenantConfig" SET "jurisdiction" = 'ZA', "currency" = 'ZAR' WHERE "tenantId" = '${stale.id}'`)
    })
    await expect(db().$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_config('app.tenant_id', 'some-other-tenant', true)`
      await tx.$executeRawUnsafe(`UPDATE "Tenant" SET "status" = 'ACTIVE' WHERE "id" = '${stale.id}'`)
    })).rejects.toThrow(REFUSED)
    // Put the legacy mismatch right: the app refuses to serve beside one (loadActiveJurisdiction).
    await db().tenantConfig.update({ where: { tenantId: stale.id }, data: { jurisdiction: "LS", currency: "LSL" } })
  })

  it("lets the settings writers upsert a TenantConfig on an LS instance (insert path and update path)", async () => {
    const t = await createChargesTenant(db(), false)
    expect(await db().tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).toMatchObject(LS)
    const actor = { id: t.userId, email: "ops@test.invalid" }
    // Update path.
    await applyStaffAccessPolicy(db() as never, { tenantId: t.tenantId, actor, next: { hours: null, ipAllowlist: ["203.0.113.5"] } })
    // Insert path: no config yet, so the upsert inserts with the ZA / ZAR column defaults.
    await db().tenantConfig.delete({ where: { tenantId: t.tenantId } })
    await applyStaffAccessPolicy(db() as never, { tenantId: t.tenantId, actor, next: { hours: null, ipAllowlist: ["203.0.113.6"] } })
    expect(await db().tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).toMatchObject({ ...LS, staffIpAllowlist: ["203.0.113.6"] })
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

  it("an LS config written here becomes ZA / ZAR; ZA lenders come in as they always did", async () => {
    await db().tenant.create({ data: { slug: "ls-new", name: "x", status: "ACTIVE", config: { create: { jurisdiction: "LS", currency: "LSL" } } } })
    expect(await db().tenantConfig.findFirstOrThrow({ where: { tenant: { slug: "ls-new" } } })).toMatchObject({ jurisdiction: "ZA", currency: "ZAR" })
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

  it("stays frozen after every application and loan is deleted (frozenAt, set by the first insert)", async () => {
    expect((await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).frozenAt).not.toBeNull()
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      for (const table of ["RepaymentSchedule", "Loan", "LoanApplication"]) await tx.$executeRawUnsafe(`DELETE FROM "${table}"`)
    })
    expect(await db().loanApplication.count()).toBe(0)
    expect(await setInstanceJurisdiction(db(), { jurisdiction: "LS", currency: "LSL", actor: "ops@test.invalid", reason: "empty again" }))
      .toMatchObject({ ok: false, error: expect.stringMatching(/had them before/) })
    await expect(db().instanceJurisdiction.update({ where: { id: 1 }, data: { jurisdiction: "LS", currency: "LSL" } })).rejects.toThrow(/cannot change once any loan application or loan exists/)
    await expect(db().instanceJurisdiction.update({ where: { id: 1 }, data: { frozenAt: null } })).rejects.toThrow(/frozenAt cannot be changed or cleared/)
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

  it("waits for the change and then takes the new value (the advisory lock), instead of slipping a ZA lender in beside LS", async () => {
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
    await create
    // Without the lock it would have read ZA and kept it: a ZA lender on a Lesotho instance.
    expect(await fresh.db.tenantConfig.findFirstOrThrow({ where: { tenant: { slug: "za-race" } } })).toMatchObject({ jurisdiction: "LS", currency: "LSL" })
  }, 120_000)
})

suite("the migration's backfill (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db
  // The DO block of the migration, run again against lenders written with the triggers off
  // (as an upgraded database that predates the row would hold them).
  const backfill = backfillBlock()
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

  it("takes the value the lenders agree on, parked ones included", async () => {
    await rerun([...lender("a-ls", "ACTIVE", "LS", "LSL"), ...lender("b-ls", "SUSPENDED", "LS", "LSL")])
    expect(await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ jurisdiction: "LS", currency: "LSL", setBy: "migration" })
  })

  it("marks the instance frozen when an application or loan already exists", async () => {
    await rerun([])
    expect((await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).frozenAt).toBeNull()
    const t = await createChargesTenant(db(), false)
    await createChargesLoan(db(), t)
    await db().$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
      await tx.$executeRawUnsafe(`DELETE FROM "InstanceJurisdiction"`)
      await tx.$executeRawUnsafe(backfill)
    })
    expect((await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).frozenAt).not.toBeNull()
  })

  it("is ZA / ZAR with no lenders", async () => {
    await rerun([])
    expect(await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject({ jurisdiction: "ZA", currency: "ZAR" })
  })

  it("fails the migration when any lender disagrees, a parked one too", async () => {
    await expect(rerun([...lender("a-ls", "ACTIVE", "LS", "LSL"), ...lender("b-za", "SUSPENDED", "ZA", "ZAR")])).rejects.toThrow(/disagree/)
  })
})

suite("an application being created while the instance is being changed (real DB)", () => {
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

  it("the change waits for the insert in flight and then refuses, instead of passing a count that missed it", async () => {
    const t = await createChargesTenant(fresh.db, false)
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    let inserted: () => void = () => undefined
    const insertedFlag = new Promise<void>((resolve) => { inserted = resolve })

    // Connection 1: a loan and its application, uncommitted.
    const insert = fresh.db.$transaction(async (tx) => {
      await createChargesLoan(tx as unknown as PrismaClient, t)
      inserted()
      await held
    }, { timeout: 60_000 })
    await insertedFlag

    // Connection 2: the operator writer. Its own count cannot see the uncommitted rows.
    let finished = false
    const change = setInstanceJurisdiction(second, { jurisdiction: "LS", currency: "LSL", actor: "ops@test.invalid", reason: "race" })
      .finally(() => { finished = true })
    change.catch(() => undefined)
    await sleep(1_000)
    expect(finished, "the instance change must wait for the insert in flight").toBe(false)
    release()
    await insert
    expect(await change).toMatchObject({ ok: false, error: expect.stringMatching(/can no longer change/) })
    expect((await fresh.db.instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).jurisdiction).toBe("ZA")
  }, 120_000)

  it("the same race through the database alone (a raw UPDATE, no writer): the trigger waits and then counts the committed insert", async () => {
    const t = await createChargesTenant(fresh.db, false)
    let release: () => void = () => undefined
    const held = new Promise<void>((resolve) => { release = resolve })
    let inserted: () => void = () => undefined
    const insertedFlag = new Promise<void>((resolve) => { inserted = resolve })
    const insert = fresh.db.$transaction(async (tx) => {
      await createChargesLoan(tx as unknown as PrismaClient, t)
      inserted()
      await held
    }, { timeout: 60_000 })
    await insertedFlag

    let finished = false
    const change = second.instanceJurisdiction.update({ where: { id: 1 }, data: { jurisdiction: "LS", currency: "LSL" } }).finally(() => { finished = true })
    change.catch(() => undefined)
    await sleep(1_000)
    expect(finished, "the instance change must wait for the insert in flight").toBe(false)
    release()
    await insert
    await expect(change).rejects.toThrow(/cannot change once any loan application or loan exists/)
  }, 120_000)
})

suite("the guards need READ COMMITTED (real DB)", () => {
  let fresh: ThrowawayDb
  let second: PrismaClient
  const RC = /READ COMMITTED/

  beforeAll(async () => {
    fresh = await createThrowawayDb()
    second = new PrismaClient({ datasources: { db: { url: fresh.url } } })
  }, 240_000)
  afterAll(async () => {
    await second?.$disconnect()
    await fresh?.drop()
  })

  it("a REPEATABLE READ tenant insert that began before the instance changed is refused, not judged on its stale snapshot", async () => {
    const result = fresh.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`
      // The instance becomes Lesotho (committed on another connection) after this snapshot was taken.
      expect(await setInstanceJurisdiction(second, { jurisdiction: "LS", currency: "LSL", actor: "ops@test.invalid", reason: "rr" })).toMatchObject({ ok: true })
      const t = await tx.tenant.create({ data: { slug: "za-rr", name: "za-rr", status: "ACTIVE" } })
      await tx.tenantConfig.create({ data: { tenantId: t.id } })
    }, { isolationLevel: "RepeatableRead" })
    await expect(result).rejects.toThrow(RC)
    expect(await fresh.db.tenant.count({ where: { slug: "za-rr" } })).toBe(0)
  }, 120_000)

  it("a REPEATABLE READ instance change is refused outright by the guard", async () => {
    await expect(fresh.db.$transaction((tx) => tx.instanceJurisdiction.update({ where: { id: 1 }, data: { jurisdiction: "ZA", currency: "ZAR" } }), { isolationLevel: "RepeatableRead" })).rejects.toThrow(RC)
  })

  it("a REPEATABLE READ instance change that began before an application committed cannot pass on a count that missed it", async () => {
    // The instance is LS now; changing it back is what the stale transaction attempts. Postgres
    // itself stops this one (the first insert also stamps frozenAt on the row the stale transaction
    // would update), so the assertion is that it is refused whichever guard speaks first and the
    // instance is untouched.
    const t = await createChargesTenant(fresh.db, false)
    const result = fresh.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1`
      await createChargesLoan(second, t)
      await tx.instanceJurisdiction.update({ where: { id: 1 }, data: { jurisdiction: "ZA", currency: "ZAR" } })
    }, { isolationLevel: "RepeatableRead" })
    await expect(result).rejects.toThrow(/READ COMMITTED|write conflict|cannot change once any loan application or loan exists/)
    expect((await fresh.db.instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).jurisdiction).toBe("LS")
  }, 120_000)

  it("a SERIALIZABLE tenant-config delete is refused too", async () => {
    const t = await createChargesTenant(fresh.db, false)
    await fresh.db.user.deleteMany({ where: { tenantId: t.tenantId } })
    await fresh.db.loanProduct.deleteMany({ where: { tenantId: t.tenantId } })
    await expect(fresh.db.$transaction((tx) => tx.tenantConfig.delete({ where: { tenantId: t.tenantId } }), { isolationLevel: "Serializable" })).rejects.toThrow(RC)
  })
})
