import { describe, expect, it } from "vitest"
import { activationConflict, instanceJurisdictionConflict, instanceJurisdictionMessage, isInstanceJurisdictionError } from "./instance.server"

function fakeDb(instance: { jurisdiction: string; currency: string } | null, configs: Record<string, { jurisdiction: string; currency: string }> = {}) {
  return {
    instanceJurisdiction: { findUnique: async () => instance },
    tenantConfig: { findUnique: async ({ where }: { where: { tenantId: string } }) => configs[where.tenantId] ?? null },
  } as never
}
const LS = { jurisdiction: "LS", currency: "LSL" }
const ZA = { jurisdiction: "ZA", currency: "ZAR" }

describe("instanceJurisdictionConflict", () => {
  it("names the instance's jurisdiction when a newcomer differs", async () => {
    const c = await instanceJurisdictionConflict(fakeDb(LS), ZA)
    expect(c?.message).toMatch(/this instance is LS\/LSL, this lender is ZA\/ZAR/)
    expect(c?.message).toMatch(/own instance and database/)
  })

  it("treats a differing currency as a clash too", async () => {
    expect(await instanceJurisdictionConflict(fakeDb(LS), { jurisdiction: "LS", currency: "ZAR" })).not.toBeNull()
  })

  it("accepts an agreeing lender and a database with no instance row yet", async () => {
    expect(await instanceJurisdictionConflict(fakeDb(LS), LS)).toBeNull()
    expect(await instanceJurisdictionConflict(fakeDb(null), ZA)).toBeNull()
  })
})

describe("activationConflict", () => {
  it("checks the tenant's own stored config, and skips a tenant with none", async () => {
    const db = fakeDb(LS, { za: ZA, ls: LS })
    expect((await activationConflict(db, "za"))?.message).toMatch(/this instance is LS/)
    expect(await activationConflict(db, "ls")).toBeNull()
    expect(await activationConflict(db, "unconfigured")).toBeNull()
  })
})

describe("the trigger's error", () => {
  it("is recognised and its message extracted from Prisma's wrapping", () => {
    const e = new Error("Invalid `prisma.tenant.update()` invocation: One instance serves one jurisdiction: this instance is LS/LSL, this lender is ZA/ZAR. Give that lender its own instance and database. extra")
    expect(isInstanceJurisdictionError(e)).toBe(true)
    expect(instanceJurisdictionMessage(e)).toMatch(/^One instance serves one jurisdiction.*database\.$/)
    expect(isInstanceJurisdictionError(new Error("other"))).toBe(false)
  })
})
