import type { ChangeRequest, ChangeRequestStatus, Prisma } from "@prisma/client"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { canDo } from "@/lib/permissions"
import { prisma } from "@/lib/prisma"
import { isStaffTotpRequired } from "@/lib/security/staff-totp-policy"
import { ChangeRequestError, InvalidPayloadError } from "./errors"
import { handlerFor } from "./handlers"
import { approvePermissionFor, type Actor, type ChangeHandler, type Tx } from "./types"

type Db = Pick<typeof prisma, "$transaction" | "changeRequest">

interface Scope {
  tenantId: string
  actor: Actor
}

export const TITLE_MAX_LENGTH = 200

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

function mayMakePayload(handler: ChangeHandler<unknown>, actor: Actor, payload: unknown): void {
  const permission = handler.makePermissionFor?.(payload)
  if (permission && !canDo(actor.role, permission)) {
    throw new ChangeRequestError("FORBIDDEN", `This kind of change to ${handler.label.toLowerCase()} needs the ${permission} permission`)
  }
}

function mayApprove(handler: ChangeHandler<unknown>, actor: Actor, payload: unknown): void {
  const permission = approvePermissionFor(handler, payload)
  if (!canDo(actor.role, permission)) {
    throw new ChangeRequestError("FORBIDDEN", `Approving ${handler.label.toLowerCase()} needs the ${permission} permission`)
  }
}

/** Approving or rejecting a change to how the lender lends is a privileged act: it needs the session's own second factor where the lender requires one. */
async function requireStepUp(tenantId: string, actor: Actor): Promise<void> {
  if (actor.totpVerified !== true && (await isStaffTotpRequired(tenantId))) {
    throw new ChangeRequestError("TOTP_REQUIRED", "Sign in with two-factor authentication to approve or reject changes. Enable it under Settings, Security, then sign out and back in.")
  }
}

/** How long a checker who set up or changed the maker's account stays barred, and how old a maker account must be. */
export const MAKER_ACCOUNT_CONTROL_DAYS = 30

/**
 * Four eyes is two different PEOPLE. A maker account younger than 30 days (whoever created it) cannot have its changes approved,
 * and a checker who created the maker's account, or reset its password, role or second factor, within the last 30 days could be
 * drafting through a puppet: both refused. The trail is the audit log the user routes already write (USER_CREATED, USER_UPDATED,
 * TOTP_RESET_BY_ADMIN).
 */
async function refuseControlledMaker(tx: Pick<Tx, "auditLog" | "user">, tenantId: string, makerId: string, checkerId: string, now: Date): Promise<void> {
  const since = new Date(now.getTime() - MAKER_ACCOUNT_CONTROL_DAYS * 24 * 60 * 60 * 1000)
  const maker = await tx.user.findFirst({ where: { id: makerId, tenantId }, select: { createdAt: true } })
  if (!maker || maker.createdAt > since) {
    throw new ChangeRequestError("MAKER_ACCOUNT_CONTROLLED", `The account that drafted this is less than ${MAKER_ACCOUNT_CONTROL_DAYS} days old (or gone): its changes cannot be approved yet`)
  }
  const control = await tx.auditLog.findFirst({
    where: {
      tenantId, entity: "User", entityId: makerId, userId: checkerId, createdAt: { gte: since },
      action: { in: [AuditAction.USER_CREATED, AuditAction.USER_UPDATED, AuditAction.TOTP_RESET_BY_ADMIN] },
    },
    select: { id: true },
  })
  if (control) throw new ChangeRequestError("MAKER_ACCOUNT_CONTROLLED", `You created or changed the account of the person who drafted this within the last ${MAKER_ACCOUNT_CONTROL_DAYS} days: another approver must decide it`)
}

async function load(tx: Pick<Tx, "changeRequest">, tenantId: string, id: string): Promise<ChangeRequest> {
  const row = await tx.changeRequest.findFirst({ where: { id, tenantId } })
  if (!row) throw new ChangeRequestError("NOT_FOUND", "Change request not found")
  return row
}

function cleanTitle(title: string): string {
  const trimmed = title.trim()
  if (trimmed.length < 1 || trimmed.length > TITLE_MAX_LENGTH) {
    throw new InvalidPayloadError([`title: 1 to ${TITLE_MAX_LENGTH} characters`])
  }
  return trimmed
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
  const title = cleanTitle(scope.title)
  const payload = handler.parse(scope.payload)
  mayMakePayload(handler, scope.actor, payload)
  return db.$transaction(async (tx) => {
    const row = await tx.changeRequest.create({
      data: {
        tenantId: scope.tenantId,
        kind: scope.kind,
        title,
        payload: payload as Prisma.InputJsonValue,
        payloadVersion: handler.payloadVersion,
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
    if (scope.title !== undefined) data.title = cleanTitle(scope.title)
    if (scope.payload !== undefined) {
      const parsed = handler.parse(scope.payload)
      mayMakePayload(handler, scope.actor, parsed)
      data.payload = parsed as Prisma.InputJsonValue
      data.payloadVersion = handler.payloadVersion
    }
    const changed = await tx.changeRequest.updateMany({ where: { id: row.id, tenantId: scope.tenantId, status: "DRAFT" }, data })
    if (changed.count !== 1) throw new ChangeRequestError("WRONG_STATE", "The change request moved on while you were editing it")
    const updated = await load(tx, scope.tenantId, row.id)
    await audit(tx, scope, AuditAction.CHANGE_REQUEST_UPDATED, updated)
    return updated
  })
}

/** DRAFT -> SUBMITTED: the payload is re-validated against the database, its base recorded, and frozen. */
export async function submit(scope: Scope & { id: string }, db: Db = prisma): Promise<ChangeRequest> {
  return db.$transaction(async (tx) => {
    const row = await load(tx, scope.tenantId, scope.id)
    const handler = handlerOrThrow(row.kind)
    mayMake(handler, scope.actor)
    if (row.makerId !== scope.actor.id) throw new ChangeRequestError("NOT_MAKER", "Only the person who drafted a change can submit it")
    // A draft's format is whatever it was drafted under: it is never re-stamped by submitting. Editing it re-parses and re-stamps.
    if (row.payloadVersion !== handler.payloadVersion) throw stale("This change was drafted under an older format. Edit it again to bring it up to date, or draft it afresh.")
    const payload = handler.parse(row.payload)
    mayMakePayload(handler, scope.actor, payload)
    await handler.verify?.(tx, scope.tenantId, payload)
    const baseRef = (await handler.baseRef?.(tx, scope.tenantId, payload)) ?? null
    const changed = await tx.changeRequest.updateMany({
      where: { id: row.id, tenantId: scope.tenantId, status: "DRAFT" },
      data: { status: "SUBMITTED", submittedAt: new Date(), baseRef },
    })
    if (changed.count !== 1) throw new ChangeRequestError("WRONG_STATE", "Only a draft can be submitted")
    const submitted = await load(tx, scope.tenantId, row.id)
    await audit(tx, scope, AuditAction.CHANGE_REQUEST_SUBMITTED, submitted, { title: submitted.title })
    return submitted
  })
}

const selfApproval = () => new ChangeRequestError("SELF_APPROVAL", "A change must be approved by someone other than the person who drafted it")
const stale = (why: string) => new ChangeRequestError("STALE", why)

/** The database holds the rule (CHECK ChangeRequest_four_eyes); this turns its refusal into the friendly one. */
function translate(error: unknown): never {
  const text = String(error)
  if (text.includes("ChangeRequest_four_eyes")) throw selfApproval()
  if ((error as { code?: string } | null)?.code === "P2002") {
    throw stale("Another change of this kind was approved at the same moment. Review the current state and approve again.")
  }
  throw error
}

/**
 * SUBMITTED -> APPROVED, applying the payload in the same transaction: the
 * handler's writes and the approval commit together or not at all. Approvals of
 * one kind for one lender are serialised, so the staleness check and `apply`
 * see the same state.
 */
export async function approve(scope: Scope & { id: string; note?: string }, db: Db = prisma): Promise<ChangeRequest> {
  await requireStepUp(scope.tenantId, scope.actor)
  try {
    return await db.$transaction(async (tx) => {
      const peek = await load(tx, scope.tenantId, scope.id)
      const handler = handlerOrThrow(peek.kind)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`maker-checker:${scope.tenantId}:${peek.kind}`}))`
      const row = await load(tx, scope.tenantId, scope.id)
      mayApprove(handler, scope.actor, row.payload)
      if (row.makerId === scope.actor.id) throw selfApproval()
      const now = new Date()
      await refuseControlledMaker(tx, scope.tenantId, row.makerId, scope.actor.id, now)
      const changed = await tx.changeRequest.updateMany({
        where: { id: row.id, tenantId: scope.tenantId, status: "SUBMITTED" },
        data: { status: "APPROVED", checkerId: scope.actor.id, decidedAt: now, appliedAt: now, decisionNote: scope.note?.trim() || null },
      })
      if (changed.count !== 1) throw new ChangeRequestError("WRONG_STATE", "Only a submitted change can be approved")
      const approved = await load(tx, scope.tenantId, row.id)
      if (approved.payloadVersion !== handler.payloadVersion) throw stale("This change was drafted under an older format. Withdraw it and draft it again.")
      const payload = handler.parse(approved.payload)
      mayApprove(handler, scope.actor, payload)
      if (handler.baseRef) {
        const current = await handler.baseRef(tx, scope.tenantId, payload)
        if (current !== approved.baseRef) throw stale("What this change was drafted against has changed since it was submitted. Withdraw it and draft it again.")
      }
      await handler.verify?.(tx, scope.tenantId, payload)
      await handler.apply(tx, { tenantId: scope.tenantId, request: approved, payload, checker: scope.actor, now })
      await audit(tx, scope, AuditAction.CHANGE_REQUEST_APPROVED, approved, { makerId: approved.makerId, note: approved.decisionNote })
      return approved
    })
  } catch (error) {
    return translate(error)
  }
}

/** SUBMITTED -> REJECTED, with the reason the maker will read. */
export async function reject(scope: Scope & { id: string; note: string }, db: Db = prisma): Promise<ChangeRequest> {
  const note = scope.note.trim()
  if (!note) throw new InvalidPayloadError(["Give the reason for rejecting this change."])
  await requireStepUp(scope.tenantId, scope.actor)
  try {
    return await db.$transaction(async (tx) => {
      const row = await load(tx, scope.tenantId, scope.id)
      const handler = handlerOrThrow(row.kind)
      mayApprove(handler, scope.actor, row.payload)
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
    return translate(error)
  }
}

/** DRAFT | SUBMITTED -> WITHDRAWN, by its maker (who must still hold the make permission). */
export async function withdraw(scope: Scope & { id: string }, db: Db = prisma): Promise<ChangeRequest> {
  return db.$transaction(async (tx) => {
    const row = await load(tx, scope.tenantId, scope.id)
    mayMake(handlerOrThrow(row.kind), scope.actor)
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

export const LIST_PAGE_SIZE = 50

export interface ListFilter {
  /** Restrict to these kinds in the database (a caller passes the kinds its viewer may see). */
  kinds?: readonly string[]
  status?: readonly ChangeRequestStatus[]
  /** Created within this many days, or still open (DRAFT, SUBMITTED). */
  recentDays?: number
  limit?: number
  /** The id of the last row of the previous page. */
  cursor?: string
}

/** Newest first, paged; the filters run in the database, so a page is never filled and then thinned. */
export async function listChangeRequests(
  tenantId: string,
  filter: ListFilter = {},
  db: Pick<typeof prisma, "changeRequest"> = prisma,
): Promise<{ rows: ChangeRequest[]; nextCursor: string | null }> {
  const limit = Math.min(Math.max(1, filter.limit ?? LIST_PAGE_SIZE), 200)
  const since = filter.recentDays ? new Date(Date.now() - filter.recentDays * 86_400_000) : null
  const rows = await db.changeRequest.findMany({
    where: {
      tenantId,
      ...(filter.kinds ? { kind: { in: [...filter.kinds] } } : {}),
      ...(filter.status ? { status: { in: [...filter.status] } } : {}),
      ...(since ? { OR: [{ status: { in: ["DRAFT", "SUBMITTED"] } }, { createdAt: { gte: since } }] } : {}),
    },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit + 1,
    ...(filter.cursor ? { cursor: { id: filter.cursor }, skip: 1 } : {}),
  })
  const page = rows.slice(0, limit)
  return { rows: page, nextCursor: rows.length > limit ? page[page.length - 1].id : null }
}

export async function getChangeRequest(tenantId: string, id: string, db: Pick<typeof prisma, "changeRequest"> = prisma): Promise<ChangeRequest> {
  return load(db, tenantId, id)
}
