import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { reconcileOutageDisbursements } from
  "@/lib/disbursement/outage-reconciliation"
import { isOutageIncidentId } from "@/lib/disbursement/outage-exception"

const MIN_MANAGEMENT_NOTE_LENGTH = 20

/**
 * Derived from the incident, not a single constant.
 *
 * With one incident a fixed string was enough. Now the confirmation must name
 * WHICH incident is being applied, so a confirmation typed for one cohort cannot
 * be replayed against another cohort's live, already-reconciled loans.
 */
function applyConfirmationFor(incidentId: string): string {
  return `RECONCILE-${incidentId.toUpperCase()}`
}

function normalizedNote(value: string): string {
  return value.trim().replace(/\s+/g, " ")
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export async function POST(request: NextRequest) {
  const guard = await requireApiRole("SUPER_ADMIN")
  if (guard.error) return guard.error

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON" },
      { status: 400 },
    )
  }
  if (!isRecord(body)) {
    return NextResponse.json(
      { error: "Request body must be an object" },
      { status: 400 },
    )
  }

  const apply = body.apply ?? false
  const managementApprovalNote =
    typeof body.managementApprovalNote === "string"
      ? normalizedNote(body.managementApprovalNote)
      : ""
  if (
    typeof apply !== "boolean"
    || managementApprovalNote.length < MIN_MANAGEMENT_NOTE_LENGTH
  ) {
    return NextResponse.json(
      {
        error:
          "A management approval note of at least 20 characters is required",
      },
      { status: 400 },
    )
  }
  // Required and validated against the allow-list. No default: reconciling the
  // wrong cohort by omission is exactly the mistake worth making impossible.
  const incidentId = typeof body.incidentId === "string" ? body.incidentId.trim() : ""
  if (!isOutageIncidentId(incidentId)) {
    return NextResponse.json(
      { error: "A known outage incidentId is required" },
      { status: 400 },
    )
  }
  if (apply && body.confirmation !== applyConfirmationFor(incidentId)) {
    return NextResponse.json(
      { error: "Exact outage reconciliation confirmation is required" },
      { status: 409 },
    )
  }

  return withTenantContext(request, async (tenant) => {
    try {
      const result = await reconcileOutageDisbursements({
        tenantId: tenant.id,
        incidentId,
        operator: {
          id: guard.user.id,
          email: guard.user.email,
        },
        managementApprovalNote,
        apply,
      })
      return NextResponse.json(result)
    } catch (error) {
      const message = error instanceof Error ? error.message : ""
      if (
        /partial|conflicting|reviewed outage|changed during|already exists/i
          .test(message)
      ) {
        // Log the real reason. The response deliberately stays generic, but
        // without this the 409 is undiagnosable from outside: six different
        // preconditions collapse into one opaque string, and the operator has no
        // way to tell "bank evidence incomplete" from "calculator mismatch" from
        // "already reconciled". That cost a full diagnostic cycle on 2026-08-06.
        console.error(
          "Outage reconciliation refused",
          { incidentId, apply, reason: message },
        )
        return NextResponse.json(
          {
            error:
              "Outage reconciliation state conflicts with the reviewed cohort",
          },
          { status: 409 },
        )
      }
      console.error("Outage disbursement reconciliation failed", error)
      return NextResponse.json(
        { error: "Outage reconciliation failed" },
        { status: 500 },
      )
    }
  })
}
