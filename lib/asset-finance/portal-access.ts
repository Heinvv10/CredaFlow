import { NextResponse } from "next/server"
import type { EntityRole, Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { ENTITY_DOCUMENT_VIEW_SELECT, toEntityDocumentView, type EntityDocumentView } from "./entity-documents"

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
 * The deal signer rows a portal client may still read and sign: their own row
 * (the caller adds `clientId`) only while they hold, on the deal's entity, an
 * ACTIVE relationship that authorises the row's role. A SURETY row needs an
 * active SURETY relationship; any other row (AUTHORISED_SIGNATORY: agreement,
 * resolution) needs an active director, trustee or authorised-signatory one.
 * A person removed from the entity after the documents were prepared loses
 * the document and the signature at once (404). Combine with AND: the caller's
 * own `deal` filter would otherwise be overwritten.
 */
export function portalSignerAuthorityWhere(tenantId: string, clientId: string): Prisma.DealSignerWhereInput {
  const holds = (roles: readonly EntityRole[]): Prisma.DealSignerWhereInput => ({
    deal: { entity: { relationships: { some: { tenantId, clientId, active: true, role: { in: [...roles] } } } } },
  })
  return {
    OR: [
      { role: "SURETY", ...holds(["SURETY"]) },
      { role: { not: "SURETY" }, ...holds(PORTAL_AUTHORITY_ROLES) },
    ],
  }
}

/**
 * The rows a portal client may read and sign: portalSignerAuthorityWhere's, or
 * (a sole proprietor's lease, slice 3) the agreement row of a lease whose
 * lessee they are themselves. Combine with AND, as above.
 */
export function portalSignerWhere(tenantId: string, clientId: string): Prisma.DealSignerWhereInput {
  return { OR: [portalSignerAuthorityWhere(tenantId, clientId), leaseLesseeSignerWhere(tenantId, clientId)] }
}

/** A sole proprietor's own lease agreement row: the lessee is the client, no entity. */
export function leaseLesseeSignerWhere(tenantId: string, clientId: string): Prisma.DealSignerWhereInput {
  return {
    role: "AUTHORISED_SIGNATORY", document: "AGREEMENT",
    deal: { tenantId, clientId, entityId: null, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } },
  }
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

/**
 * The entity documents a portal client may list and download (POPIA). A
 * signed suretyship scan is a personal contract between ONE surety and the
 * lender: only the surety whose signer row binds it (DealSigner.scanDocumentId
 * → DealSigner.clientId) sees it, never the entity's other directors or
 * signatories. A scan no signer row binds (one replaced before it was
 * confirmed) is shown to nobody in the portal. Staff are unaffected.
 */
export function portalVisibleEntityDocumentWhere(clientId: string): Prisma.EntityDocumentWhereInput {
  return {
    OR: [
      { docType: { not: "SIGNED_SURETYSHIP" } },
      { signerScans: { some: { clientId, document: "SURETYSHIP" } } },
    ],
  }
}

/** The entity's live documents as a portal client may see them (metadata only). */
export async function loadPortalEntityDocuments(
  tenantId: string,
  entityId: string,
  clientId: string,
  db: Pick<typeof prisma, "entityDocument"> = prisma,
): Promise<EntityDocumentView[]> {
  const rows = await db.entityDocument.findMany({
    where: { tenantId, entityId, deletedAt: null, ...portalVisibleEntityDocumentWhere(clientId) },
    orderBy: { createdAt: "desc" },
    select: ENTITY_DOCUMENT_VIEW_SELECT,
  })
  return rows.map(toEntityDocumentView)
}
