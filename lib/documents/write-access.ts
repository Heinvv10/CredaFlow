import { NextResponse } from "next/server"
import type { UserRole } from "@prisma/client"
import { auditDocumentAccessRefusal } from "@/lib/audit-refusals"
import type { CallerInfo } from "@/lib/document-auth"

/**
 * Staff roles that may view and list client documents but never change one
 * (Hein, 2026-10-16). Every other staff role in getDocumentCaller's list keeps
 * full access, and a portal client keeps its own-document upload, sign and
 * selfie paths. The one list: routes and UI ask the helpers below.
 */
export const DOCUMENT_READ_ONLY_ROLES: readonly UserRole[] = ["READONLY"]

export const READ_ONLY_DOCUMENT_ERROR = "Your role can view documents but not change them."

export type DocumentWriteAction = "upload" | "selfie" | "sign" | "extract" | "request_signature"

export function isDocumentReadOnlyRole(role: UserRole | null | undefined): boolean {
  return role != null && DOCUMENT_READ_ONLY_ROLES.includes(role)
}

export function canWriteDocuments(caller: CallerInfo): boolean {
  return caller.type === "client" || !isDocumentReadOnlyRole(caller.role)
}

/**
 * The 403 a document write route returns to a read-only staff caller, with the
 * refusal on the audit trail; null when the caller may write. Call it before
 * the route parses its body or touches the database, a file or a job.
 */
export async function refuseReadOnlyDocumentWrite(params: {
  caller: CallerInfo
  documentId: string
  tenantId: string
  action: DocumentWriteAction
  req: Request
}): Promise<NextResponse | null> {
  const { caller } = params
  if (canWriteDocuments(caller) || caller.type !== "staff") return null

  // Never throws: logAudit records its own failure and the refusal stands.
  await auditDocumentAccessRefusal({
    documentId: params.documentId,
    reason: "document_write_read_only_role",
    status: 403,
    tenantId: params.tenantId,
    actorUserId: caller.userId,
    detail: { action: params.action, role: caller.role },
  })
  return NextResponse.json({ error: READ_ONLY_DOCUMENT_ERROR }, { status: 403 })
}
