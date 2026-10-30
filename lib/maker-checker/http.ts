import { NextResponse } from "next/server"
import type { ChangeRequest } from "@prisma/client"
import { canDo } from "@/lib/permissions"
import { ChangeRequestError } from "./errors"
import { handlerFor, registeredKinds } from "./handlers"
import { approvePermissionFor } from "./types"

/** A ChangeRequestError as the JSON answer a route gives; anything else is rethrown for the route's own 500. */
export function changeRequestErrorResponse(error: unknown): NextResponse {
  if (error instanceof ChangeRequestError) {
    return NextResponse.json({ error: error.message, code: error.code, problems: error.problems }, { status: error.status })
  }
  throw error
}

function mayApproveRow(role: string, row: Pick<ChangeRequest, "kind" | "payload">): boolean {
  const handler = handlerFor(row.kind)
  if (!handler) return false
  try {
    return canDo(role, approvePermissionFor(handler, handler.parse(row.payload)))
  } catch {
    // A stored payload this version cannot read cannot be approved by anyone.
    return false
  }
}

/** Whether a role may see a request: it can make that kind of change or approve this one. */
export function maySeeRow(role: string, row: Pick<ChangeRequest, "kind" | "payload">): boolean {
  const handler = handlerFor(row.kind)
  return handler !== null && (canDo(role, handler.makePermission) || mayApproveRow(role, row))
}

/**
 * The kinds worth querying for a role, so the database does the narrowing:
 * those it can make, and those whose approval permission is a plain key it holds
 * or depends on the payload (the caller then thins with maySeeRow).
 */
export function candidateKinds(role: string): string[] {
  return registeredKinds().filter((kind) => {
    const handler = handlerFor(kind)!
    return canDo(role, handler.makePermission) || typeof handler.approvePermission === "function" || canDo(role, handler.approvePermission)
  })
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
    canApprove: row.status === "SUBMITTED" && row.makerId !== viewerId && mayApproveRow(role, row),
  }
}
