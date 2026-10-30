import { NextRequest, NextResponse } from "next/server"
import { ncaOnlyRefusal } from "@/lib/jurisdiction/nca-only"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAuditStrict } from "@/lib/audit"
import {
  finaliseSection129Issuance,
  loadSection129ReservationForReconciliation,
  releaseSection129IssuanceAfterReconciliation,
  Section129ArtifactIntegrityError,
  Section129ArtifactUnavailableError,
  Section129IssuanceConflictError,
  verifySection129ReservationIntegrity,
} from "@/lib/collections/section129-artifact"

type RouteCtx = { params: Promise<{ id: string }> }

/**
 * Resolve the unavoidable external-provider/DB uncertainty window without
 * ever retrying a potentially delivered statutory notice. This is an audited
 * LOAN_ADMIN action; ordinary collections officers cannot self-certify it.
 */
export async function POST(req: NextRequest, { params }: RouteCtx) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const notNca = await ncaOnlyRefusal("Section 129 notices")
  if (notNca) return notNca

  return withTenantContext(req, async (tenant) => {
    const { id: loanId } = await params
    const body = await req.json() as {
      issuanceId?: string
      outcome?: "ISSUED" | "NOT_SENT"
      reason?: string
      emailMessageId?: string
      providerAcceptedAt?: string
    }
    const reason = body.reason?.trim() ?? ""
    const providerEvidenceReference = body.emailMessageId?.trim() ?? ""
    if (!body.issuanceId || !["ISSUED", "NOT_SENT"].includes(body.outcome ?? "") || reason.length < 10) {
      return NextResponse.json(
        { error: "issuanceId, outcome (ISSUED or NOT_SENT), and a reconciliation reason of at least 10 characters are required" },
        { status: 422 },
      )
    }
    let providerAcceptedAt: Date | undefined
    if (body.outcome === "ISSUED") {
      if (
        providerEvidenceReference.length < 3
        || providerEvidenceReference.length > 512
        || /[\u0000-\u001F\u007F]/.test(providerEvidenceReference)
      ) {
        return NextResponse.json(
          { error: "emailMessageId is required for an ISSUED reconciliation and must be a 3-512 character provider message or log reference without control characters" },
          { status: 422 },
        )
      }
      const providerTimestamp = body.providerAcceptedAt?.trim() ?? ""
      const hasExplicitTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
        providerTimestamp,
      )
      providerAcceptedAt = new Date(providerTimestamp)
      if (!hasExplicitTimezone || !Number.isFinite(providerAcceptedAt.getTime())) {
        return NextResponse.json(
          { error: "providerAcceptedAt is required for an ISSUED reconciliation and must be a valid ISO timestamp with Z or an explicit timezone offset" },
          { status: 422 },
        )
      }
      if (providerAcceptedAt.getTime() > Date.now()) {
        return NextResponse.json(
          { error: "providerAcceptedAt cannot be in the future" },
          { status: 422 },
        )
      }
    }

    try {
      const reservation = await loadSection129ReservationForReconciliation({
        tenantId: tenant.id,
        loanId,
        issuanceId: body.issuanceId,
      })
      if (body.outcome === "ISSUED") {
        const dispatchBoundary = Date.parse(
          reservation.recordData.dispatchStartedAt
            ?? reservation.recordData.reservedAt,
        )
        const acceptedAt = providerAcceptedAt as Date
        // Provider logs and the UI can have minute precision. Permit a small
        // clock/precision skew, but reject a timestamp materially predating
        // the reserved provider-dispatch window.
        if (
          !Number.isFinite(dispatchBoundary)
          || acceptedAt.getTime() < dispatchBoundary - 5 * 60 * 1000
        ) {
          return NextResponse.json(
            { error: "providerAcceptedAt predates the reserved provider-dispatch window" },
            { status: 422 },
          )
        }
        await verifySection129ReservationIntegrity(reservation)
        await finaliseSection129Issuance({
          reservation,
          tenantId: tenant.id,
          loanId,
          issuedById: guard.user.id,
          issuedByEmail: guard.user.email,
          emailMessageId: providerEvidenceReference,
          reconciliationReason: reason,
          issuedAt: acceptedAt,
        })
      } else {
        await releaseSection129IssuanceAfterReconciliation({
          reservation,
          tenantId: tenant.id,
          loanId,
          reconciledById: guard.user.id,
          reconciledByEmail: guard.user.email,
          reason,
        })
      }
      return NextResponse.json({
        ok: true,
        issuanceId: body.issuanceId,
        outcome: body.outcome,
        ...(body.outcome === "ISSUED" ? { emailMessageId: providerEvidenceReference } : {}),
        ...(providerAcceptedAt ? { providerAcceptedAt: providerAcceptedAt.toISOString() } : {}),
      })
    } catch (error) {
      if (error instanceof Section129ArtifactUnavailableError) {
        return NextResponse.json({ error: error.message }, { status: 404 })
      }
      if (error instanceof Section129ArtifactIntegrityError) {
        try {
          await logAuditStrict({
            tenantId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            action: "SECTION_129_RECONCILIATION_INTEGRITY_FAILED",
            entity: "Loan",
            entityId: loanId,
            newValue: {
              issuanceId: error.issuanceId,
              expectedHash: error.expectedHash,
              actualHash: error.actualHash,
            },
          })
        } catch {
          return NextResponse.json(
            {
              error: "The reserved Section 129 artifact failed its integrity check, and the integrity incident could not be written to the audit trail. Reconciliation remains blocked.",
              auditRequired: true,
            },
            { status: 503 },
          )
        }
        return NextResponse.json(
          { error: "The reserved Section 129 artifact failed its integrity check and cannot be reconciled as issued." },
          { status: 409 },
        )
      }
      if (error instanceof Section129IssuanceConflictError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      throw error
    }
  })
}
