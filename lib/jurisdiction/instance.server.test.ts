import { describe, expect, it } from "vitest"
import { activationConflict, instanceJurisdictionConflict, instanceJurisdictionMessage, isInstanceJurisdictionError } from "./instance.server"

const config = (slug: string, jurisdiction: string, currency: string, tenantId = slug) => ({ tenantId, jurisdiction, currency, tenant: { slug } })
function fakeDb(configs: ReturnType<typeof config>[]) {
  return {
    tenantConfig: {
      findMany: async ({ where }: { where: { tenantId?: { not: string } } }) => configs.filter((c) => c.tenantId !== where.tenantId?.not),
      findUnique: async ({ where }: { where: { tenantId: string } }) => configs.find((c) => c.tenantId === where.tenantId) ?? null,
    },
  } as never
}

describe("instanceJurisdictionConflict", () => {
  it("names the ACTIVE lender a ZA newcomer clashes with", async () => {
    const c = await instanceJurisdictionConflict(fakeDb([config("basotho", "LS", "LSL")]), { tenantId: null, jurisdiction: "ZA", currency: "ZAR" })
    expect(c?.other).toBe("basotho=LS/LSL")
    expect(c?.message).toMatch(/own instance and database/)
  })

  it("treats a differing currency as a clash too, and ignores the subject itself", async () => {
    const db = fakeDb([config("a", "LS", "LSL"), config("b", "LS", "ZAR")])
    expect(await instanceJurisdictionConflict(db, { tenantId: "a", jurisdiction: "LS", currency: "LSL" })).not.toBeNull()
    expect(await instanceJurisdictionConflict(fakeDb([config("a", "LS", "LSL")]), { tenantId: "a", jurisdiction: "LS", currency: "LSL" })).toBeNull()
  })

  it("accepts an empty instance and an agreeing one", async () => {
    expect(await instanceJurisdictionConflict(fakeDb([]), { tenantId: null, jurisdiction: "LS", currency: "LSL" })).toBeNull()
    expect(await instanceJurisdictionConflict(fakeDb([config("a", "ZA", "ZAR")]), { tenantId: null, jurisdiction: "ZA", currency: "ZAR" })).toBeNull()
  })
})

describe("activationConflict", () => {
  it("checks the tenant's own stored config, and skips a tenant with none", async () => {
    const db = fakeDb([config("za", "ZA", "ZAR"), config("ls", "LS", "LSL")])
    expect((await activationConflict(db, "za"))?.other).toBe("ls=LS/LSL")
    expect(await activationConflict(db, "unconfigured")).toBeNull()
  })
})

describe("the trigger's error", () => {
  it("is recognised and its message extracted from Prisma's wrapping", () => {
    const e = new Error("Invalid `prisma.tenant.update()` invocation: One instance serves one jurisdiction: an ACTIVE lender here is basotho=LS/LSL, this one would be ZA/ZAR. Give that lender its own instance and database. extra")
    expect(isInstanceJurisdictionError(e)).toBe(true)
    expect(instanceJurisdictionMessage(e)).toMatch(/^One instance serves one jurisdiction.*database\.$/)
    expect(isInstanceJurisdictionError(new Error("other"))).toBe(false)
  })
})
