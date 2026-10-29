import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyRefusal } from "@/lib/jurisdiction/nca-only"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { auditRefusal } from "@/lib/audit-refusals"
import { sastCalendarDate } from "@/lib/date/sast"
import { referenceRateAccess } from "@/lib/asset-finance/reference-rate-access"
import { decideReferenceRate, type ReferenceRateDecision } from "@/lib/asset-finance/reference-rate-decision"
import { referenceRateView } from "../../view"

function parseDecision(body: unknown): ReferenceRateDecision | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null
  const { decision } = body as { decision?: unknown }
  return decision === "APPROVE" || decision === "REJECT" ? decision : null
}

/**
 * Approve or reject a PENDING reference rate (DESIGN D4, four-eyes).
 * Body: `{ decision: "APPROVE" | "REJECT" }`.
 *
 * Needs decide_asset_finance, and the decider must not be the user who
 * recorded it (also CHECK ReferenceRate_four_eyes); both refusals are 403 and
 * audited. Only an APPROVED value reprices loans. The response carries
 * `reach` on an approval: how many loans the cron will reprice on it, and
 * whether the loan admins were alerted that it reprices none
 * (lib/asset-finance/reference-rate-decision.ts).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error
  const notNca = ncaOnlyRefusal("Reference rates")
  if (notNca) return notNca

  return withTenantContext(req, async (tenant) => {
    const { id } = await params
    const target = await prisma.referenceRate.findFirst({ where: { id, tenantId: tenant.id }, select: { basis: true } })
    if (!target) return NextResponse.json({ error: "Reference rate not found" }, { status: 404 })
    const refuse = async (reason: string, error: string) => {
      await auditRefusal({
        action: AuditAction.REFERENCE_RATE_REFUSED,
        entity: "ReferenceRate",
        entityId: id,
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        reason,
        status: 403,
      })
      return NextResponse.json({ error }, { status: 403 })
    }

    // REPO: manage_repo_rate, any tenant. Others: asset finance on + decide_asset_finance.
    const access = await referenceRateAccess(tenant.id, target.basis, guard.user.role)
    if (!access.ok) {
      return access.reason
        ? refuse(access.reason, `Deciding this reference rate needs the ${access.permission} permission`)
        : access.response
    }
    const decision = parseDecision(await req.json().catch(() => null))
    if (!decision) return NextResponse.json({ error: "decision must be APPROVE or REJECT" }, { status: 400 })

    const result = await prisma.$transaction((tx) => decideReferenceRate(tx, {
      tenantId: tenant.id,
      rateId: id,
      decision,
      deciderId: guard.user.id,
      deciderEmail: guard.user.email,
      today: sastCalendarDate(new Date()),
    }))

    switch (result.kind) {
      case "not_found":
        return NextResponse.json({ error: "Reference rate not found" }, { status: 404 })
      case "not_pending":
        return NextResponse.json({ error: `The reference rate is already ${result.status}` }, { status: 409 })
      case "self_decision":
        return refuse("four_eyes_self_decision", "A reference rate must be decided by someone other than the user who recorded it")
      case "decided":
        return NextResponse.json({ ...referenceRateView(result.rate), reach: result.reach })
    }
  })
}
