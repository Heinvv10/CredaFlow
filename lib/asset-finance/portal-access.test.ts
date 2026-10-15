import { describe, expect, it, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import {
  authorisedEntityIdsForClient,
  loadPortalEntityDocuments,
  PORTAL_AUTHORITY_ROLES,
  portalSignerAuthorityWhere,
  portalVisibleEntityDocumentWhere,
  requirePortalEntityAccess,
} from "./portal-access"

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

// Real-database proof: portal-contract.integration.test.ts (a booked deal with
// two wet-ink suretyship scans).
describe("portal entity documents (POPIA: another surety's signed suretyship)", () => {
  it("withholds every SIGNED_SURETYSHIP but the one bound to this client's own suretyship signer row", () => {
    expect(portalVisibleEntityDocumentWhere("c1").AND).toContainEqual({
      OR: [
        { docType: { not: "SIGNED_SURETYSHIP" } },
        { signerScans: { some: { clientId: "c1", document: "SURETYSHIP" } } },
      ],
    })
  })

  it("withholds the lender's legal-matter evidence and any refund's bank-verification document", () => {
    const and = portalVisibleEntityDocumentWhere("c1").AND
    expect(and).toContainEqual({ docType: { not: "LEGAL_DOCUMENT" } })
    expect(and).toContainEqual({ recoveryRefunds: { none: {} } })
  })

  it("lists only the live documents of this tenant and entity that the client may see", async () => {
    const findMany = vi.fn().mockResolvedValue([])
    await loadPortalEntityDocuments("t1", "e1", "c1", { entityDocument: { findMany } } as never)
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { tenantId: "t1", entityId: "e1", deletedAt: null, ...portalVisibleEntityDocumentWhere("c1") },
    }))
  })
})

describe("portal deal signer authority (M1)", () => {
  const relationship = (roles: string[]) => ({
    deal: { entity: { relationships: { some: { tenantId: "t1", clientId: "c1", active: true, role: { in: roles } } } } },
  })

  it("a SURETY row needs an active SURETY relationship; any other row an active authorising one", () => {
    expect(portalSignerAuthorityWhere("t1", "c1")).toEqual({
      OR: [
        { role: "SURETY", ...relationship(["SURETY"]) },
        { role: { not: "SURETY" }, ...relationship(["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"]) },
      ],
    })
  })

  it("never lets a SURETY relationship authorise an agreement or resolution row", () => {
    const branches = portalSignerAuthorityWhere("t1", "c1").OR ?? []
    const nonSurety = branches.find((b) => typeof b.role === "object")
    const roles = (nonSurety?.deal as { entity: { relationships: { some: { role: { in: string[] } } } } }).entity.relationships.some.role.in
    expect(roles).not.toContain("SURETY")
  })
})
