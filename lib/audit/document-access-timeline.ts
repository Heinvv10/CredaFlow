import { Prisma } from "@prisma/client"

export interface AuditTimelineEntry {
  id: string
  userId: string | null
  userEmail: string | null
  userName: string | null
  actorLabel: string
  action: string
  entity: string
  entityId: string | null
  oldValue: Record<string, unknown> | null
  newValue: Record<string, unknown> | null
  ipAddress: string | null
  createdAt: string
}

export interface DocumentAccessRow {
  id: string
  documentId: string
  accessorType: string
  accessorId: string
  action: string
  ipAddress: string | null
  userAgent: string | null
  createdAt: Date
}

export interface AuditActor {
  id: string
  name: string | null
  email: string
}

export interface DocumentAccessReader {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
}

export interface DocumentAccessQueryOptions {
  from?: Date
  to?: Date
  staffUserId?: string
  search?: string
  limit?: number
}

function documentAccessQuery(
  tenantId: string,
  options: DocumentAccessQueryOptions,
): Prisma.Sql {
  const conditions = [Prisma.sql`document."tenantId" = ${tenantId}`]
  if (options.from) conditions.push(Prisma.sql`access."createdAt" >= ${options.from}`)
  if (options.to) conditions.push(Prisma.sql`access."createdAt" <= ${options.to}`)
  if (options.staffUserId) {
    conditions.push(Prisma.sql`
      UPPER(access."accessorType") = 'STAFF'
      AND access."accessorId" = ${options.staffUserId}
    `)
  }
  const search = options.search?.trim()
  if (search) {
    const pattern = `%${search}%`
    conditions.push(Prisma.sql`(
      access."action" ILIKE ${pattern}
      OR ('DOCUMENT_' || UPPER(REGEXP_REPLACE(TRIM(access."action"), '[^A-Za-z0-9]+', '_', 'g'))) ILIKE ${pattern}
      OR 'ClientDocument' ILIKE ${pattern}
      OR access."documentId" ILIKE ${pattern}
      OR access."accessorType" ILIKE ${pattern}
      OR access."accessorId" ILIKE ${pattern}
      OR COALESCE(access."ipAddress", '') ILIKE ${pattern}
      OR COALESCE(actor."name", '') ILIKE ${pattern}
      OR COALESCE(actor."email", '') ILIKE ${pattern}
    )`)
  }
  const limit = Math.max(1, Math.min(options.limit ?? 100, 50_001))

  return Prisma.sql`
  SELECT
    access."id",
    access."documentId",
    access."accessorType",
    access."accessorId",
    access."action",
    access."ipAddress",
    access."userAgent",
    access."createdAt"
  FROM "DocumentAccessLog" AS access
  INNER JOIN "ClientDocument" AS document
    ON document."id" = access."documentId"
  LEFT JOIN "User" AS actor
    ON actor."id" = access."accessorId"
    AND actor."tenantId" = document."tenantId"
    AND UPPER(access."accessorType") = 'STAFF'
  WHERE ${Prisma.join(conditions, " AND ")}
  ORDER BY access."createdAt" DESC
  LIMIT ${limit}
`
}

export async function readTenantDocumentAccess(
  reader: DocumentAccessReader,
  tenantId: string,
  options: DocumentAccessQueryOptions = {},
): Promise<DocumentAccessRow[]> {
  return reader.$queryRaw<DocumentAccessRow[]>(documentAccessQuery(tenantId, options))
}

function documentAction(action: string): string {
  const suffix = action.trim().toUpperCase().replace(/[^A-Z0-9]+/g, "_") || "ACCESSED"
  return `DOCUMENT_${suffix}`
}

export function documentAccessTimelineEntries(
  rows: DocumentAccessRow[],
  users: AuditActor[],
): AuditTimelineEntry[] {
  const usersById = new Map(users.map((user) => [user.id, user]))

  return rows.map((row) => {
    const accessorType = row.accessorType.trim().toUpperCase()
    const isSystem = row.accessorId.trim().toLowerCase() === "system"
    const isStaff = accessorType === "STAFF" && !isSystem
    const isClient = accessorType === "CLIENT"
    const user = isStaff ? usersById.get(row.accessorId) : undefined

    return {
      id: `document-access:${row.id}`,
      userId: isStaff ? row.accessorId : null,
      userEmail: user?.email ?? null,
      userName: isSystem
        ? "System"
        : isStaff
        ? user?.name ?? user?.email ?? "Staff user"
        : isClient
          ? "Client portal"
          : `${row.accessorType} access`,
      actorLabel: isSystem
        ? "system"
        : isStaff
        ? user?.email ?? `staff ${row.accessorId}`
        : isClient
          ? `client portal ${row.accessorId}`
          : `${accessorType.toLowerCase()} ${row.accessorId}`,
      action: documentAction(row.action),
      entity: "ClientDocument",
      entityId: row.documentId,
      oldValue: null,
      newValue: {
        accessorType: row.accessorType,
        accessorId: row.accessorId,
        accessAction: row.action,
        userAgent: row.userAgent,
      },
      ipAddress: row.ipAddress,
      createdAt: row.createdAt.toISOString(),
    }
  })
}

export function mergeAuditTimeline(
  auditRows: AuditTimelineEntry[],
  documentRows: AuditTimelineEntry[],
  limit = 100,
): AuditTimelineEntry[] {
  return [...auditRows, ...documentRows]
    .sort((left, right) => Date.parse(right.createdAt) - Date.parse(left.createdAt))
    .slice(0, limit)
}
