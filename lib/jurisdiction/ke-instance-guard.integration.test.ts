/**
 * Real-Postgres proof that a Kenyan instance is one jurisdiction like the
 * others (migrations 20261108090000_kenya_enum_values and
 * 20261108090100_kenya_jurisdiction_currency): KE is billed in KES only, on the
 * lender and on the instance, and the generic guards of
 * 20261029120000_instance_jurisdiction hold a KE instance as they hold LS.
 * The Lesotho and South African cases are in instance-guard.integration.test.ts.
 *
 *   RUN_DB_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run lib/jurisdiction/ke-instance-guard.integration.test.ts
 *
 * The role needs CREATEDB (as prisma/seed.integration.test.ts does).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest"
import { createChargesTenant } from "@/lib/loan/charges.integration-fixture"
import { activeCurrency, activeJurisdiction, resetActiveJurisdiction } from "./active"
import { setInstanceJurisdiction } from "./instance-write"
import { loadActiveJurisdiction, resetEnsuredJurisdiction } from "./load.server"
import { createThrowawayDb, type ThrowawayDb } from "./throwaway-db.integration-fixture"

const suite = process.env.RUN_DB_IT === "1" ? describe.sequential : describe.skip
const REFUSED = /One instance serves one jurisdiction/
const KE = { jurisdiction: "KE", currency: "KES" } as const

suite("a Kenyan instance (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  beforeAll(async () => {
    fresh = await createThrowawayDb({ instance: KE })
  }, 240_000)
  afterAll(() => fresh?.drop())
  afterEach(() => { resetActiveJurisdiction(); resetEnsuredJurisdiction() })

  it("accepts a lender that is KE / KES", async () => {
    await db().tenant.create({ data: { slug: "ke-active", name: "ke-active", status: "ACTIVE", config: { create: KE } } })
    expect(await db().tenantConfig.findFirstOrThrow({ where: { tenant: { slug: "ke-active" } } })).toMatchObject(KE)
  })

  it("gives a new ZA or LS config the instance's values, and refuses to move an existing one off KE", async () => {
    for (const [slug, config] of [
      ["ke-from-za", { jurisdiction: "ZA", currency: "ZAR" }],
      ["ke-from-ls", { jurisdiction: "LS", currency: "LSL" }],
    ] as const) {
      await db().tenant.create({ data: { slug, name: slug, status: "ACTIVE", config: { create: config } } })
      expect(await db().tenantConfig.findFirstOrThrow({ where: { tenant: { slug } } })).toMatchObject(KE)
    }
    const one = await db().tenant.findUniqueOrThrow({ where: { slug: "ke-active" } })
    await expect(db().tenantConfig.update({ where: { tenantId: one.id }, data: { jurisdiction: "ZA", currency: "ZAR" } })).rejects.toThrow(REFUSED)
    await expect(db().tenantConfig.update({ where: { tenantId: one.id }, data: { currency: "LSL" } })).rejects.toThrow(REFUSED)
  })

  it("refuses KE with rand on the instance row and, with the guards off, on a lender (the CHECKs)", async () => {
    await expect(db().$executeRawUnsafe(`UPDATE "InstanceJurisdiction" SET "currency" = 'ZAR'`)).rejects.toThrow(/InstanceJurisdiction_jurisdiction_currency/)
    const one = await db().tenant.findUniqueOrThrow({ where: { slug: "ke-active" } })
    for (const pair of [`'KE', 'ZAR'`, `'KE', 'LSL'`, `'ZA', 'KES'`, `'LS', 'KES'`]) {
      await expect(db().$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = replica`)
        await tx.$executeRawUnsafe(`UPDATE "TenantConfig" SET ("jurisdiction", "currency") = (${pair}) WHERE "tenantId" = '${one.id}'`)
      }), pair).rejects.toThrow(/TenantConfig_jurisdiction_currency/)
    }
  })

  it("the app loads KE / KES from the instance row", async () => {
    await loadActiveJurisdiction(db() as never)
    expect(activeJurisdiction()).toBe("KE")
    expect(activeCurrency()).toBe("KES")
  })
})

suite("the operator writer moves an empty instance to Kenya (real DB)", () => {
  let fresh: ThrowawayDb
  const db = () => fresh.db

  beforeAll(async () => { fresh = await createThrowawayDb() }, 240_000)
  afterAll(() => fresh?.drop())

  it("refuses KE with rand, then moves the instance and its lenders to KE / KES and audits it", async () => {
    const t = await createChargesTenant(db(), false)
    expect(await setInstanceJurisdiction(db(), { jurisdiction: "KE", currency: "ZAR", actor: "ops@test.invalid", reason: "Kenya demo" }))
      .toEqual({ ok: false, error: "A KE instance is billed in KES only" })
    expect(await setInstanceJurisdiction(db(), { ...KE, actor: "ops@test.invalid", reason: "Kenya demo" }))
      .toEqual({ ok: true, changed: true, ...KE })
    expect(await db().instanceJurisdiction.findUniqueOrThrow({ where: { id: 1 } })).toMatchObject(KE)
    expect(await db().tenantConfig.findUniqueOrThrow({ where: { tenantId: t.tenantId } })).toMatchObject(KE)
    const audit = await db().auditLog.findFirstOrThrow({ where: { action: "INSTANCE_JURISDICTION_SET" } })
    expect(audit.newValue).toMatchObject({ ...KE, reason: "Kenya demo", lendersMoved: 1 })
  })
})
