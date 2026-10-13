import { NextResponse } from "next/server"
import type { EntityRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"

// Who may act for a BusinessEntity in the client portal (goal decision 2a.2).
// A portal Client holding an ACTIVE director, trustee or authorised-signatory
// relationship sees the entity's applications, deals and loans and may upload
// its documents. Every other role — SURETY, MEMBER, BENEFICIAL_OWNER — grants
// nothing on its own: a surety guarantees the debt but has no authority to
// act for the borrower, and must not read its records.
//
// Every portal route and page that touches an entity calls
// requirePortalEntityAccess. The answer to "not authorised" is 404, never
// 403, so a client cannot learn that an entity they are not party to exists.

export const PORTAL_AUTHORITY_ROLES: readonly EntityRole[] = ["DIRECTOR", "TRUSTEE", "AUTHORISED_SIGNATORY"]

type Db = Pick<typeof prisma, "entityRelationship">

/** The ids of the entities this client may act for, oldest relationship first. */
export async function authorisedEntityIdsForClient(
  tenantId: string,
  clientId: string,
  db: Db = prisma,
): Promise<string[]> {
  const rows = await db.entityRelationship.findMany({
    where: { tenantId, clientId, active: true, role: { in: [...PORTAL_AUTHORITY_ROLES] } },
    select: { entityId: true },
    orderBy: { createdAt: "asc" },
  })
  return [...new Set(rows.map((r) => r.entityId))]
}

/** True when the client holds an active authorising role in this entity. */
export async function isPortalEntityAuthorised(
  tenantId: string,
  clientId: string,
  entityId: string,
  db: Db = prisma,
): Promise<boolean> {
  const row = await db.entityRelationship.findFirst({
    where: { tenantId, clientId, entityId, active: true, role: { in: [...PORTAL_AUTHORITY_ROLES] } },
    select: { id: true },
  })
  return row !== null
}

/**
 * null when the client may act for the entity; otherwise the 404 to return.
 * Pages call `notFound()` on a non-null answer.
 */
export async function requirePortalEntityAccess(
  tenantId: string,
  clientId: string,
  entityId: string,
  db: Db = prisma,
): Promise<NextResponse | null> {
  if (await isPortalEntityAuthorised(tenantId, clientId, entityId, db)) return null
  return NextResponse.json({ error: "Not found" }, { status: 404 })
}
