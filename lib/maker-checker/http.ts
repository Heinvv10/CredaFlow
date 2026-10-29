import { NextResponse } from "next/server"
import { ChangeRequestError } from "./errors"
import { handlerFor } from "./handlers"
import { canDo } from "@/lib/permissions"
import type { ChangeRequest } from "@prisma/client"

/** A ChangeRequestError as the JSON answer a route gives; anything else is rethrown for the route's own 500. */
export function changeRequestErrorResponse(error: unknown): NextResponse {
  if (error instanceof ChangeRequestError) {
    return NextResponse.json({ error: error.message, code: error.code, problems: error.problems }, { status: error.status })
  }
  throw error
}

/** Whether a role may see requests of this kind: it can make or approve them. */
export function maySeeKind(role: string, kind: string): boolean {
  const handler = handlerFor(kind)
  return handler !== null && (canDo(role, handler.makePermission) || canDo(role, handler.approvePermission))
}

/** The request as a client sees it: who may act on it is decided by the service, not by this shape. */
export function presentChangeRequest(row: ChangeRequest, viewerId: string, role: string) {
  const handler = handlerFor(row.kind)
  return {
    id: row.id,
    kind: row.kind,
    label: handler?.label ?? row.kind,
    title: row.title,
    status: row.status,
    payload: row.payload,
    makerId: row.makerId,
    checkerId: row.checkerId,
    decisionNote: row.decisionNote,
    createdAt: row.createdAt,
    submittedAt: row.submittedAt,
    decidedAt: row.decidedAt,
    // Hints for the UI only; the service enforces every one of these.
    mine: row.makerId === viewerId,
    canApprove: row.status === "SUBMITTED" && row.makerId !== viewerId && handler !== null && canDo(role, handler.approvePermission),
  }
}
