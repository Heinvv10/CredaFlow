import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"

/**
 * Records that the PPR / product disclosure has been ISSUED to the
 * policyholder. Issuance is a staff act, so it belongs here.
 *
 * It deliberately cannot record the client's ACKNOWLEDGEMENT. This route used
 * to accept pprAcknowledgedAt/pprAcknowledgedBy from the request body, which
 * let a staff member assert — in the client's name, with no evidence — that the
 * client had accepted a disclosure. pprAcknowledgedAt feeds the FSCA quarterly
 * return (lib/fsca-return.ts), so that was a regulatory record any staff
 * session could manufacture. Acknowledgement now happens only where the client
 * themselves can perform it:
 * app/api/portal/insurance/policies/[id]/ppr-acknowledge.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const policy = await prisma.insurancePolicy.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true, pprIssuedAt: true, faisDisclosurePdfUrl: true },
      })
      if (!policy) return NextResponse.json({ error: "Policy not found" }, { status: 404 })

      // "Issued" must mean a document exists. The disbursement path already
      // refuses to stamp this without the artifact — it stamps "ONLY once that
      // artifact actually exists" (app/api/applications/[id]/disburse/route.ts)
      // because auto-stamping is a false compliance claim. This route had no
      // such precondition, so it could assert issuance of nothing. pprIssuedAt
      // gates status = ACTIVE and is the FSCA return's denominator.
      if (!policy.faisDisclosurePdfUrl) {
        return NextResponse.json(
          { error: "Cannot record issuance: no disclosure document is stored against this policy." },
          { status: 409 },
        )
      }

      // Issuance is set once. The previous implementation wrote
      // `pprIssuedAt: new Date()` on every call, so a repeat POST silently
      // moved the recorded issuance date to "now" — losing the real one.
      if (policy.pprIssuedAt) {
        return NextResponse.json({
          id: policy.id,
          pprIssuedAt: policy.pprIssuedAt.toISOString(),
          alreadyIssued: true,
        })
      }

      const issuedAt = new Date()

      const claimed = await prisma.insurancePolicy.updateMany({
        where: { id, tenantId: tenant.id, pprIssuedAt: null },
        data: { pprIssuedAt: issuedAt },
      })

      if (claimed.count !== 1) {
        const current = await prisma.insurancePolicy.findFirst({
          where: { id, tenantId: tenant.id },
          select: { pprIssuedAt: true },
        })
        return NextResponse.json({
          id: policy.id,
          pprIssuedAt: current?.pprIssuedAt?.toISOString() ?? null,
          alreadyIssued: true,
        })
      }

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email ?? undefined,
        action: AuditAction.INSURANCE_PPR_ISSUED,
        entity: "InsurancePolicy",
        entityId: policy.id,
        oldValue: { pprIssuedAt: null },
        newValue: { pprIssuedAt: issuedAt.toISOString() },
      })

      return NextResponse.json({
        id: policy.id,
        pprIssuedAt: issuedAt.toISOString(),
      })
    })
  } catch (error) {
    console.error("Failed to record PPR:", error)
    return NextResponse.json({ error: "Failed to record PPR" }, { status: 500 })
  }
}
