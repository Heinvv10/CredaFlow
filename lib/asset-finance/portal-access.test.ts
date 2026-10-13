import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { authorisedEntityIdsForClient, PORTAL_AUTHORITY_ROLES, requirePortalEntityAccess } from "./portal-access"

// The real-database proof is portal-access.integration.test.ts; this pins the
// query the rule is made of.
describe("portal entity access", () => {
  it("grants authority to directors, trustees and authorised signatories only", () => {
    expect([...PORTAL_AUTHORITY_ROLES].sort()).toEqual(["AUTHORISED_SIGNATORY", "DIRECTOR", "TRUSTEE"])
  })

  it("asks only for ACTIVE authorising rows of this tenant and client", async () => {
    const findFirst = vi.fn().mockResolvedValue(null)
    const response = await requirePortalEntityAccess("t1", "c1", "e1", { entityRelationship: { findFirst } } as never)
    expect(response?.status).toBe(404)
    expect(findFirst).toHaveBeenCalledWith({
      where: { tenantId: "t1", clientId: "c1", entityId: "e1", active: true, role: { in: ["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"] } },
      select: { id: true },
    })
  })

  it("answers null (allowed) when such a row exists", async () => {
    const findFirst = vi.fn().mockResolvedValue({ id: "r1" })
    expect(await requirePortalEntityAccess("t1", "c1", "e1", { entityRelationship: { findFirst } } as never)).toBeNull()
  })

  it("lists each authorised entity once", async () => {
    const findMany = vi.fn().mockResolvedValue([{ entityId: "e1" }, { entityId: "e2" }, { entityId: "e1" }])
    expect(await authorisedEntityIdsForClient("t1", "c1", { entityRelationship: { findMany } } as never)).toEqual(["e1", "e2"])
  })
})
