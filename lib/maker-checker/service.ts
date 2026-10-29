import type { ChangeRequest, Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { canDo } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import { ChangeRequestError, InvalidPayloadError } from "./errors"
import { handlerFor } from "./handlers"
import type { Actor, ChangeHandler, Tx } from "./types"

type Db = Pick<typeof prisma, "$transaction" | "changeRequest">

interface Scope {
  tenantId: string
  actor: Actor
}

function handlerOrThrow(kind: string): ChangeHandler<unknown> {
  const handler = handlerFor(kind)
  if (!handler) throw new ChangeRequestError("UNKNOWN_KIND", `Unknown change kind ${kind}`)
  return handler
}

function mayMake(handler: ChangeHandler<unknown>, actor: Actor): void {
  if (!canDo(actor.role, handler.makePermission)) {
    throw new ChangeRequestError("FORBIDDEN", `Changing ${handler.label.toLowerCase()} needs the ${handler.makePermission} permission`)
  }
}

function mayApprove(handler: ChangeHandler<unknown>, actor: Actor): void {
  if (!canDo(actor.role, handler.approvePermission)) {
    throw new ChangeRequestError("FORBIDDEN", `Approving ${handler.label.toLowerCase()} needs the ${handler.approvePermission} permission`)
  }
}

async function load(tx: Pick<Tx, "changeRequest">, tenantId: string, id: string): Promise<ChangeRequest> {
  const row = await tx.changeRequest.findFirst({ where: { id, tenantId } })
  if (!row) throw new ChangeRequestError("NOT_FOUND", "Change request not found")
  return row
}

type AuditActionName = (typeof AuditAction)[keyof typeof AuditAction]

function audit(tx: Tx, scope: Scope, action: AuditActionName, row: Pick<ChangeRequest, "id" | "kind" | "status">, extra: Record<string, unknown> = {}) {
  return logAuditStrict({
    tenantId: scope.tenantId,
    userId: scope.actor.id,
    userEmail: scope.actor.email,
    action,
    entity: "ChangeRequest",
    entityId: row.id,
    newValue: { kind: row.kind, status: row.status, ...extra },
  }, tx)
}

/** A new DRAFT. The payload is validated now, and stored in its normalised form. */
export async function createDraft(
  scope: Scope & { kind: string; title: string; payload: unknown },
  db: Db = prisma,
): Promise<ChangeRequest> {
  const handler = handlerOrThrow(scope.kind)
  mayMake(handler, scope.actor)
  const payload = handler.parse(scope.payload)
  return db.$transaction(async (tx) => {
    const row = await tx.changeRequest.create({
      data: {
        tenantId: scope.tenantId,
        kind: scope.kind,
        title: scope.title.trim(),
        payload: payload as Prisma.InputJsonValue,
        makerId: scope.actor.id,
      },
    })
    await audit(tx, scope, AuditAction.CHANGE_REQUEST_DRAFTED, row, { title: row.title })
    return row
  })
}

/** Edits a DRAFT. Only its maker may, and only while it is a draft. */
export async function updateDraft(
  scope: Scope & { id: string; title?: string; payload?: unknown },
  db: Db = prisma,
): Promise<ChangeRequest> {
  return db.$transaction(async (tx) => {
    const row = await load(tx, scope.tenantId, scope.id)
    const handler = handlerOrThrow(row.kind)
    mayMake(handler, scope.actor)
    if (row.makerId !== scope.actor.id) throw new ChangeRequestError("NOT_MAKER", "Only the person who drafted a change can edit it")
    if (row.status !== "DRAFT") throw new ChangeRequestError("WRONG_STATE", "Only a draft can be edited")
    const data: Prisma.ChangeRequestUpdateManyMutationInput = {}
    if (scope.title !== undefined) data.title = scope.title.trim()
    if (scope.payload !== undefined) data.payload = handler.parse(scope.payload) as Prisma.InputJsonValue
    const changed = await tx.changeRequest.updateMany({ where: { id: row.id, tenantId: scope.tenantId, status: "DRAFT" }, data })
    if (changed.count !== 1) throw new ChangeRequestError("WRONG_STATE", "The change request moved on while you were editing it")
    const updated = await load(tx, scope.tenantId, row.id)
    await audit(tx, scope, AuditAction.CHANGE_REQUEST_UPDATED, updated)
    return updated
  })
}

/** DRAFT -> SUBMITTED: the payload is re-validated against the database and frozen. */
export async function submit(scope: Scope & { id: string }, db: Db = prisma): Promise<ChangeRequest> {
  return db.$transaction(async (tx) => {
    const row = await load(tx, scope.tenantId, scope.id)
    const handler = handlerOrThrow(row.kind)
    mayMake(handler, scope.actor)
    if (row.makerId !== scope.actor.id) throw new ChangeRequestError("NOT_MAKER", "Only the person who drafted a change can submit it")
    const payload = handler.parse(row.payload)
    await handler.verify?.(tx, scope.tenantId, payload)
    const changed = await tx.changeRequest.updateMany({
      where: { id: row.id, tenantId: scope.tenantId, status: "DRAFT" },
      data: { status: "SUBMITTED", submittedAt: new Date() },
    })
    if (changed.count !== 1) throw new ChangeRequestError("WRONG_STATE", "Only a draft can be submitted")
    const submitted = await load(tx, scope.tenantId, row.id)
    await audit(tx, scope, AuditAction.CHANGE_REQUEST_SUBMITTED, submitted, { title: submitted.title })
    return submitted
  })
}

const selfApproval = () => new ChangeRequestError("SELF_APPROVAL", "A change must be approved by someone other than the person who drafted it")

/** The database holds the rule (CHECK ChangeRequest_four_eyes); this turns its refusal into the friendly one. */
function rethrowFourEyes(error: unknown): never {
  throw String(error).includes("ChangeRequest_four_eyes") ? selfApproval() : error
}

/**
 * SUBMITTED -> APPROVED, applying the payload in the same transaction: the
 * handler's writes and the approval commit together or not at all.
 */
export async function approve(scope: Scope & { id: string; note?: string }, db: Db = prisma): Promise<ChangeRequest> {
  try {
    return await db.$transaction(async (tx) => {
      const row = await load(tx, scope.tenantId, scope.id)
      const handler = handlerOrThrow(row.kind)
      mayApprove(handler, scope.actor)
      if (row.makerId === scope.actor.id) throw selfApproval()
      const now = new Date()
      const changed = await tx.changeRequest.updateMany({
        where: { id: row.id, tenantId: scope.tenantId, status: "SUBMITTED" },
        data: { status: "APPROVED", checkerId: scope.actor.id, decidedAt: now, appliedAt: now, decisionNote: scope.note?.trim() || null },
      })
      if (changed.count !== 1) throw new ChangeRequestError("WRONG_STATE", "Only a submitted change can be approved")
      const approved = await load(tx, scope.tenantId, row.id)
      const payload = handler.parse(approved.payload)
      await handler.verify?.(tx, scope.tenantId, payload)
      await handler.apply(tx, { tenantId: scope.tenantId, request: approved, payload, checker: scope.actor, now })
      await audit(tx, scope, AuditAction.CHANGE_REQUEST_APPROVED, approved, { makerId: approved.makerId, note: approved.decisionNote })
      return approved
    })
  } catch (error) {
    return rethrowFourEyes(error)
  }
}

/** SUBMITTED -> REJECTED, with the reason the maker will read. */
export async function reject(scope: Scope & { id: string; note: string }, db: Db = prisma): Promise<ChangeRequest> {
  const note = scope.note.trim()
  if (!note) throw new InvalidPayloadError(["Give the reason for rejecting this change."])
  try {
    return await db.$transaction(async (tx) => {
      const row = await load(tx, scope.tenantId, scope.id)
      mayApprove(handlerOrThrow(row.kind), scope.actor)
      if (row.makerId === scope.actor.id) throw selfApproval()
      const changed = await tx.changeRequest.updateMany({
        where: { id: row.id, tenantId: scope.tenantId, status: "SUBMITTED" },
        data: { status: "REJECTED", checkerId: scope.actor.id, decidedAt: new Date(), decisionNote: note },
      })
      if (changed.count !== 1) throw new ChangeRequestError("WRONG_STATE", "Only a submitted change can be rejected")
      const rejected = await load(tx, scope.tenantId, row.id)
      await audit(tx, scope, AuditAction.CHANGE_REQUEST_REJECTED, rejected, { makerId: rejected.makerId, note })
      return rejected
    })
  } catch (error) {
    return rethrowFourEyes(error)
  }
}

/** DRAFT | SUBMITTED -> WITHDRAWN, by its maker. */
export async function withdraw(scope: Scope & { id: string }, db: Db = prisma): Promise<ChangeRequest> {
  return db.$transaction(async (tx) => {
    const row = await load(tx, scope.tenantId, scope.id)
    if (row.makerId !== scope.actor.id) throw new ChangeRequestError("NOT_MAKER", "Only the person who drafted a change can withdraw it")
    const changed = await tx.changeRequest.updateMany({
      where: { id: row.id, tenantId: scope.tenantId, status: { in: ["DRAFT", "SUBMITTED"] } },
      data: { status: "WITHDRAWN", decidedAt: new Date() },
    })
    if (changed.count !== 1) throw new ChangeRequestError("WRONG_STATE", "Only a draft or submitted change can be withdrawn")
    const withdrawn = await load(tx, scope.tenantId, row.id)
    await audit(tx, scope, AuditAction.CHANGE_REQUEST_WITHDRAWN, withdrawn)
    return withdrawn
  })
}

export async function listChangeRequests(
  tenantId: string,
  filter: { kind?: string; status?: ChangeRequest["status"] } = {},
  db: Pick<typeof prisma, "changeRequest"> = prisma,
): Promise<ChangeRequest[]> {
  return db.changeRequest.findMany({
    where: { tenantId, ...(filter.kind ? { kind: filter.kind } : {}), ...(filter.status ? { status: filter.status } : {}) },
    orderBy: { createdAt: "desc" },
    take: 200,
  })
}

export async function getChangeRequest(tenantId: string, id: string, db: Pick<typeof prisma, "changeRequest"> = prisma): Promise<ChangeRequest> {
  return load(db, tenantId, id)
}
