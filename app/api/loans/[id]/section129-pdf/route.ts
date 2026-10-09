import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAuditStrict } from "@/lib/audit"
import {
  loadIssuedSection129Artifact,
  Section129ArtifactIntegrityError,
  Section129ArtifactUnavailableError,
} from "@/lib/collections/section129-artifact"

type RouteCtx = { params: Promise<{ id: string }> }

/**
 * Serve the exact PDF bytes attached to a successful issuance. This endpoint
 * deliberately never regenerates a current-dated statutory notice from live
 * balances: doing so would create a second operative artifact without dispatch,
 * cooldown, persistence or audit controls.
 */
export async function GET(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("COLLECTIONS_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { id } = await params

    const loan = await prisma.loan.findUnique({
      where: { id, tenantId: tenant.id },
      select: {
        id: true,
        reference: true,
      },
    })
    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 })

    try {
      const artifact = await loadIssuedSection129Artifact({
        tenantId: tenant.id,
        loanId: loan.id,
      })

      try {
        await logAuditStrict({
          tenantId: tenant.id,
          userId: guard.user.id,
          userEmail: guard.user.email,
          action: "SECTION_129_ARTIFACT_VIEWED",
          entity: "Loan",
          entityId: loan.id,
          newValue: { issuanceId: artifact.issuanceId, pdfSha256: artifact.pdfSha256 },
        })
      } catch (error) {
        console.error("[section129-pdf] access audit failed; document withheld", {
          loanId: loan.id,
          issuanceId: artifact.issuanceId,
          error,
        })
        return NextResponse.json(
          { error: "The document cannot be released because its access audit could not be recorded." },
          { status: 503 },
        )
      }

      return new Response(new Uint8Array(artifact.pdf), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${artifact.fileName}"`,
          "Cache-Control": "private, no-store",
        },
      })
    } catch (error) {
      if (error instanceof Section129ArtifactUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      if (error instanceof Section129ArtifactIntegrityError) {
        try {
          await logAuditStrict({
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: "SECTION_129_ARTIFACT_INTEGRITY_FAILED",
            entity: "Loan",
            entityId: loan.id,
            newValue: {
              issuanceId: error.issuanceId,
              expectedHash: error.expectedHash,
              actualHash: error.actualHash,
            },
          })
        } catch (auditError) {
          console.error("[section129-pdf] integrity audit failed", { loanId: loan.id, auditError })
          return NextResponse.json(
            { error: "The artifact failed integrity verification and the incident audit could not be recorded." },
            { status: 503 },
          )
        }
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
      console.error("[section129-pdf] stored artifact read failed", { loanId: id, error })
      return NextResponse.json(
        { error: "Failed to read the issued Section 129 artifact" },
        { status: 500 },
      )
    }
  })
}
