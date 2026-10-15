import { requireMinRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { getStaffTenantId } from "@/lib/session-tenant"
import { Header } from "@/components/layout/Header"
import { withStrAuditVisibility } from "@/lib/fic/audit-visibility"
import { AuditLogClient } from "./AuditLogClient"
import {
  documentAccessTimelineEntries,
  mergeAuditTimeline,
  readTenantDocumentAccess,
  type AuditTimelineEntry,
  type DocumentAccessReader,
} from "@/lib/audit/document-access-timeline"

export default async function AuditLogPage() {
  const user = await requireMinRole("LOAN_ADMIN")
  const tenantId = await getStaffTenantId()

  const [logs, documentAccess, users] = await Promise.all([
    prisma.auditLog.findMany({
      // Null-tenant legacy rows are not attributable evidence and cannot safely
      // be shown to every tenant. The tenant audit view is fail-closed.
      // Tipping off: STR rows only for the FIC compliance role (lib/fic/audit-visibility.ts).
      where: withStrAuditVisibility({ tenantId }, user.role),
      orderBy: { createdAt: "desc" },
      take: 100,
      include: { user: { select: { name: true, email: true } } },
    }),
    readTenantDocumentAccess(prisma as unknown as DocumentAccessReader, tenantId),
    prisma.user.findMany({
      // Include inactive staff so historical document access remains attributable
      // after an employee is deactivated.
      where: { tenantId },
      select: { id: true, name: true, email: true },
      orderBy: { name: "asc" },
    }),
  ])

  const platformTimeline: AuditTimelineEntry[] = logs.map((log) => ({
    id: log.id,
    userId: log.userId,
    userEmail: log.userEmail,
    userName: log.user?.name ?? log.user?.email ?? null,
    actorLabel: log.userEmail ?? (log.userId ? `staff ${log.userId}` : "system"),
    action: log.action,
    entity: log.entity,
    entityId: log.entityId,
    oldValue: log.oldValue as Record<string, unknown> | null,
    newValue: log.newValue as Record<string, unknown> | null,
    ipAddress: log.ipAddress,
    createdAt: log.createdAt.toISOString(),
  }))
  const documentTimeline = documentAccessTimelineEntries(documentAccess, users)

  return (
    <>
      <Header
        title="Settings"
        subtitle="Audit Log — all platform activity"
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Audit log" },
        ]}
      />
      <AuditLogClient
        initialLogs={mergeAuditTimeline(platformTimeline, documentTimeline)}
        users={users}
      />
    </>
  )
}
