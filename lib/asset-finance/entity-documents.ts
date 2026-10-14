import { Prisma, type EntityDocumentType } from "@prisma/client"
import type { prisma } from "@/lib/prisma"

// Rules over EntityDocument rows that the classifier and the routes share.
// A document counts as evidence only once a staff member has verified it and
// while it is not soft-deleted.

type Db = Pick<typeof prisma, "entityDocument">

/** Documents that evidence turnover / asset value for the NCA classifier. */
export const FINANCIALS_EVIDENCE_TYPES: readonly EntityDocumentType[] = ["AFS", "MANAGEMENT_ACCOUNTS"]

/**
 * Types a portal client may upload for their entity: onboarding paperwork
 * only. Signed agreements, suretyships and resolutions have their own signing
 * path (goal §4.9) and payout evidence is staff work, so neither is filed here.
 */
export const PORTAL_UPLOAD_DOC_TYPES: readonly EntityDocumentType[] = [
  "CIPC_REGISTRATION",
  "TRUST_DEED",
  "LETTERS_OF_AUTHORITY",
  "RESOLUTION",
  "AFS",
  "MANAGEMENT_ACCOUNTS",
  "BANK_STATEMENT",
  "OTHER",
]

/**
 * Types staff may upload through the generic entity route. The SIGNED_* types
 * are excluded: a loose upload must never be mistaken for executed signing
 * evidence, which the signing flow binds to its deal.
 */
export const STAFF_UPLOAD_DOC_TYPES: readonly EntityDocumentType[] = [
  ...PORTAL_UPLOAD_DOC_TYPES.filter((t) => t !== "OTHER"),
  "SUPPLIER_INVOICE",
  "INSURANCE_NOTING",
  "TRACKER_CERTIFICATE",
  "DELIVERY_ACCEPTANCE",
  "NATIS_DOCUMENT",
  "VALUATION",
  "OTHER",
]

/**
 * Lock the entity row for the rest of the transaction. Every write that
 * reads or changes financialsEvidenceIds or the figures it evidences takes
 * this lock first (set evidence, delete a document, update the entity), so a
 * document deleted concurrently can never be left behind as evidence.
 */
export async function lockBusinessEntity(
  db: Pick<typeof prisma, "$queryRaw">,
  tenantId: string,
  entityId: string,
): Promise<boolean> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "BusinessEntity"
    WHERE "id" = ${entityId} AND "tenantId" = ${tenantId}
    FOR UPDATE
  `)
  return rows.length > 0
}

/** The entity's verified, live Letters of Authority — the classifier's trustee evidence. */
export async function verifiedTrusteeEvidenceIds(db: Db, tenantId: string, entityId: string): Promise<string[]> {
  const rows = await db.entityDocument.findMany({
    where: {
      tenantId,
      entityId,
      docType: "LETTERS_OF_AUTHORITY",
      verifiedAt: { not: null },
      deletedAt: null,
    },
    select: { id: true },
    orderBy: { createdAt: "asc" },
  })
  return rows.map((r) => r.id)
}

/**
 * The ids in `ids` that are NOT this entity's verified, live AFS or
 * management-accounts documents. Empty means every id is acceptable evidence.
 */
export async function invalidFinancialsEvidenceIds(
  db: Db,
  tenantId: string,
  entityId: string,
  ids: readonly string[],
): Promise<string[]> {
  if (ids.length === 0) return []
  const rows = await db.entityDocument.findMany({
    where: {
      tenantId,
      entityId,
      id: { in: [...ids] },
      docType: { in: [...FINANCIALS_EVIDENCE_TYPES] },
      verifiedAt: { not: null },
      deletedAt: null,
    },
    select: { id: true },
  })
  const valid = new Set(rows.map((r) => r.id))
  return ids.filter((id) => !valid.has(id))
}

/** The public shape of a document: never the storage path. */
export interface EntityDocumentView {
  id: string
  entityId: string | null
  clientId: string | null
  dealId: string | null
  docType: EntityDocumentType
  fileName: string
  mimeType: string
  fileSize: number
  uploadedByType: string
  verifiedAt: string | null
  verifiedById: string | null
  createdAt: string
}

export const ENTITY_DOCUMENT_VIEW_SELECT = {
  id: true,
  entityId: true,
  clientId: true,
  dealId: true,
  docType: true,
  fileName: true,
  mimeType: true,
  fileSize: true,
  uploadedByType: true,
  verifiedAt: true,
  verifiedById: true,
  createdAt: true,
} as const

export function toEntityDocumentView(row: {
  id: string
  entityId: string | null
  clientId: string | null
  dealId: string | null
  docType: EntityDocumentType
  fileName: string
  mimeType: string
  fileSize: number
  uploadedByType: string
  verifiedAt: Date | null
  verifiedById: string | null
  createdAt: Date
}): EntityDocumentView {
  return {
    ...row,
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }
}
