import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { PERMISSIONS, requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"
import { listStrCases } from "@/lib/fic/registers"
import { TIPPING_OFF_WARNING, canTransitionStr, logStrAccess, parseStrUpdate } from "@/lib/fic/str-cases"

/**
 * GET   — one STR case (logged).
 * PATCH — move it on: UNDER_REVIEW, REPORTED (FIC reference + filing date) or
 *         CLOSED_NO_REPORT (reason). FIC compliance role only. The update, its
 *         access-log row and its audit row commit together; the trigger
 *         guardSuspiciousReportCase refuses anything the route would not.
 */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const [row] = await listStrCases(tenant.id, { id })
    if (!row) return NextResponse.json({ error: "Case not found" }, { status: 404 })
    await logStrAccess(prisma, { tenantId: tenant.id, userId: guard.user.id, action: "VIEW_CASE", caseId: row.id })
    return NextResponse.json({ case: row, warning: TIPPING_OFF_WARNING })
  })
}

export async function PATCH(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole(PERMISSIONS.manage_fic_compliance)
  if (guard.error) return guard.error
  return withTenantContext(req, async (tenant) => {
    const { id } = await ctx.params
    const parsed = parseStrUpdate((await req.json().catch(() => null)) as Record<string, unknown> | null)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const update = parsed.value

    const outcome = await prisma.$transaction(async (tx) => {
      const current = await tx.suspiciousReportCase.findFirst({ where: { id, tenantId: tenant.id }, select: { status: true } })
      if (!current) return { status: 404 as const, error: "Case not found" }
      if (!canTransitionStr(current.status, update.status)) {
        return { status: 409 as const, error: `A ${current.status} case cannot move to ${update.status}.` }
      }
      const now = new Date()
      const data =
        update.status === "UNDER_REVIEW"
          ? { status: update.status }
          : update.status === "REPORTED"
            ? { status: update.status, fiuReference: update.fiuReference, reportedAt: update.reportedAt, assessmentNote: update.assessmentNote, assessedById: guard.user.id, assessedAt: now }
            : { status: update.status, assessmentNote: update.assessmentNote, assessedById: guard.user.id, assessedAt: now, closedAt: now }
      const written = await tx.suspiciousReportCase.updateMany({ where: { id, tenantId: tenant.id, status: current.status }, data })
      if (written.count !== 1) return { status: 409 as const, error: "The case changed; refresh and try again." }
      await logStrAccess(tx, { tenantId: tenant.id, userId: guard.user.id, action: "UPDATE_CASE", caseId: id })
      await logAuditStrict({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.STR_CASE_UPDATED,
        entity: "SuspiciousReportCase",
        entityId: id,
        oldValue: { status: current.status },
        newValue: { status: update.status },
        ipAddress: callerIp(req),
      }, tx)
      return { status: 200 as const }
    })
    if (outcome.status !== 200) return NextResponse.json({ error: outcome.error }, { status: outcome.status })
    return NextResponse.json({ ok: true, status: update.status })
  })
}
