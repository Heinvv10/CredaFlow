import { NextRequest, NextResponse } from "next/server"
import { canDo, requireApiRole } from "@/lib/auth-guards"
import { DelegationError, grantDelegation, listDelegations } from "@/lib/approval/delegations"
import { withTenantContext } from "@/lib/tenant"

const date = (v: unknown): Date | null => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v) : null)

/** The lender's approval delegations, newest first (ended and expired ones included). */
export async function GET(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "view_approval_matrix")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const rows = await listDelegations(tenant.id)
    return NextResponse.json({
      delegations: rows.map((d) => ({
        id: d.id, delegatorId: d.delegatorId, delegatorName: d.delegator.name || d.delegator.email, delegateId: d.delegateId, delegateName: d.delegate.name || d.delegate.email,
        level: d.level, maxAmountCents: d.maxAmountCents, validFrom: d.validFrom.toISOString(), validTo: d.validTo.toISOString(), reason: d.reason,
        revokedAt: d.revokedAt?.toISOString() ?? null, createdAt: d.createdAt.toISOString(),
      })),
    })
  })
}

/** Delegates the caller's authority: { delegateId, level, maxAmountCents, validFrom, validTo, reason, delegatorId? } (delegatorId: an administrator, for someone else). */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  if (!canDo(guard.user.role, "manage_approval_delegations")) return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  return withTenantContext(req, async (tenant) => {
    const body = (await req.json().catch(() => null)) as Record<string, unknown> | null
    const validFrom = date(body?.validFrom)
    const validTo = date(body?.validTo)
    if (!body || typeof body.delegateId !== "string" || !validFrom || !validTo || typeof body.reason !== "string") {
      return NextResponse.json({ error: "Expected { delegateId, level, maxAmountCents, validFrom, validTo, reason }" }, { status: 400 })
    }
    try {
      const created = await grantDelegation({
        tenantId: tenant.id, actor: guard.user,
        delegation: {
          delegatorId: typeof body.delegatorId === "string" ? body.delegatorId : undefined, delegateId: body.delegateId,
          level: Number(body.level), maxAmountCents: Number(body.maxAmountCents), validFrom, validTo, reason: body.reason,
        },
      })
      return NextResponse.json({ id: created.id }, { status: 201 })
    } catch (error) {
      if (error instanceof DelegationError) return NextResponse.json({ error: error.message, code: error.code, problems: error.problems }, { status: error.status })
      throw error
    }
  })
}
