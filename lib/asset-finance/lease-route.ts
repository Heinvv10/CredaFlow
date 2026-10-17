// The gate every lease-servicing route passes (slice 3, C5–C8), staff or
// portal, and how a lib result becomes a response.
//
// STAFF: a staff session, the session bound to the request's tenant, the
// tenant's asset-finance flag, the permission (refused 403, audited), and the
// loan must be one of the tenant's leases (404). PORTAL: lib/asset-finance/
// lease-portal-route.ts withPortalLease (the lessee, or an entity lessee's
// authorised people). The action runs in one transaction; a refusal is
// audited as LEASE_ACTION_REFUSED (outside it) and answered 409, or 422 for
// a missing prerequisite; errors that mean "not now" map as payouts do.
import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { canDo, requireApiRole, type PermissionKey } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { sastCalendarDate } from "@/lib/date/sast"
import { requireAssetFinanceEnabled } from "./require-enabled"
import { payoutErrorResponse } from "./payout-route"
import { withPortalLease } from "./lease-portal-route"
import type { SigningTx } from "./signing-prepare"

export type LeaseActionResult =
  | { kind: "not_found" }
  | { kind: "refused"; reason: string; error: string }
  | ({ kind: string } & Record<string, unknown>)

type Actor = { tenantId: string; userId: string; userEmail?: string | null } | { tenantId: string; clientId: string }

const PREREQUISITES = new Set(["final_reading", "start_reading", "recipient", "valuation", "valuation_stale", "purchase_terms", "vat_not_configured", "penalty"])

async function respond(result: LeaseActionResult, ctx: { tenantId: string; loanId: string; userId?: string; email?: string | null; action: string }): Promise<NextResponse> {
  if (result.kind === "not_found") return NextResponse.json({ error: "Not found" }, { status: 404 })
  if (result.kind === "refused" && typeof result.reason === "string" && typeof result.error === "string") {
    const status = result.reason === "insufficient_role" ? 403 : result.reason.startsWith("invalid_") ? 400 : PREREQUISITES.has(result.reason) ? 422 : 409
    await auditRefusal({
      action: AuditAction.LEASE_ACTION_REFUSED, entity: "Loan", entityId: ctx.loanId, tenantId: ctx.tenantId, userId: ctx.userId,
      userEmail: ctx.email ?? undefined, reason: result.reason, status, detail: { action: ctx.action },
    })
    return NextResponse.json({ error: result.error, reason: result.reason }, { status })
  }
  return NextResponse.json(result, { status: 200 })
}

/** Thrown to roll the action's transaction back: a refusal never keeps a write made before it. */
class Refused extends Error {
  constructor(readonly result: LeaseActionResult) {
    super("lease action refused")
  }
}

async function run(actor: Actor, action: (tx: SigningTx, actor: Actor, today: string) => Promise<LeaseActionResult>): Promise<LeaseActionResult> {
  try {
    return await prisma.$transaction(async (tx) => {
      const result = await action(tx, actor, sastCalendarDate(new Date()))
      if (result.kind === "refused" || result.kind === "not_found") throw new Refused(result)
      // Surface deferred database refusals before Prisma hands an HTTP success back.
      await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE")
      return result
    }, { timeout: 20_000 })
  } catch (error) {
    if (error instanceof Refused) return error.result
    const mapped = payoutErrorResponse(error)
    if (mapped) return { kind: "refused", reason: mapped.reason, error: mapped.error }
    throw error
  }
}

export async function leaseStaffAction(
  req: Request,
  opts: { loanId: string; permission: PermissionKey; action: string },
  action: (tx: SigningTx, actor: { tenantId: string; userId: string; userEmail?: string | null }, today: string, body: Record<string, unknown>) => Promise<LeaseActionResult>,
): Promise<Response> {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const user = guard.user
  return withTenantContext(req, async (tenant) => {
    const disabled = await requireAssetFinanceEnabled(tenant.id)
    if (disabled) return disabled
    const ctx = { tenantId: tenant.id, loanId: opts.loanId, userId: user.id, email: user.email, action: opts.action }
    if (!canDo(user.role, opts.permission)) {
      return respond({ kind: "refused", reason: "insufficient_role", error: `This step needs the ${opts.permission} permission` }, ctx)
    }
    const lease = await prisma.loan.findFirst({ where: { id: opts.loanId, tenantId: tenant.id, contractType: { in: ["OPERATING_LEASE", "FULL_MAINTENANCE_LEASE"] } }, select: { id: true } })
    if (!lease) return NextResponse.json({ error: "Lease not found" }, { status: 404 })
    const body = await readBody(req)
    if (!body) return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 })
    const actor = { tenantId: tenant.id, userId: user.id, userEmail: user.email }
    return respond(await run(actor, (tx, a, today) => action(tx, a as typeof actor, today, body)), ctx)
  })
}

export async function leasePortalAction(
  req: Request,
  loanId: string,
  actionName: string,
  action: (tx: SigningTx, actor: { tenantId: string; clientId: string }, today: string, body: Record<string, unknown>) => Promise<LeaseActionResult>,
): Promise<Response> {
  return withPortalLease(req, loanId, async ({ tenantId, client }) => {
    const body = await readBody(req)
    if (!body) return NextResponse.json({ error: "Expected a JSON object" }, { status: 400 })
    const actor = { tenantId, clientId: client.clientId }
    return respond(await run(actor, (tx, a, today) => action(tx, a as typeof actor, today, body)), { tenantId, loanId, email: client.email, action: actionName })
  })
}

async function readBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.text()
  if (text.trim() === "") return {}
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    return null // not JSON: a 400, never an action on defaulted input
  }
  return typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

/** Body field readers: a refusal names the field. */
export const text = (body: Record<string, unknown>, key: string): string | null => (typeof body[key] === "string" ? (body[key] as string) : null)
const INT32_MAX = 2_147_483_647
/** A whole, non-negative number that fits the database's 32-bit columns (cents, meter values). */
export const cents = (body: Record<string, unknown>, key: string): number | null => {
  const value = body[key]
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= INT32_MAX ? value : null
}
/** A real calendar date, YYYY-MM-DD. */
export const isoDate = (body: Record<string, unknown>, key: string): string | null => {
  const value = text(body, key)
  if (value === null || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00Z`)
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value ? value : null
}
export const badRequest = (field: string, error: string): LeaseActionResult => ({ kind: "refused", reason: `invalid_${field}`, error })
