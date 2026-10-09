import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"

const VALID_COMMISSION_STATUSES = new Set(["NOT_ELIGIBLE", "PENDING", "PAYABLE", "BLOCKED", "REVERSED"])
const VALID_QUALITY_FLAGS = new Set(["", "UNMATCHED_CODE", "DUPLICATE", "LOW_QUALITY", "MANUAL_REVIEW", "APPROVED"])

function cleanNullable(value: unknown, max = 500) {
  if (typeof value !== "string") return undefined
  const text = value.trim().slice(0, max)
  return text || null
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error
  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    const existing = await prisma.referralEvent.findFirst({ where: { id, tenantId: tenant.id } })
    if (!existing) return NextResponse.json({ error: "Referral event not found" }, { status: 404 })

    // A JSON body of `null`, a string, or an array parses fine but is not a
    // record — reading fields off it threw a TypeError and surfaced as a 500.
    const parsed = await req.json().catch(() => null) as unknown
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 })
    }
    const body = parsed as { commissionStatus?: unknown; qualityFlag?: unknown; decisionNote?: unknown }
    const data: { commissionStatus?: string; qualityFlag?: string | null; metadata?: Record<string, unknown> } = {}

    if (body.commissionStatus !== undefined) {
      // Type-checked, not String()-coerced: String(["BLOCKED"]) is "BLOCKED",
      // so an array reached the valid-value set and was written as a decision.
      if (typeof body.commissionStatus !== "string") return NextResponse.json({ error: "Invalid commission status" }, { status: 400 })
      const commissionStatus = body.commissionStatus.trim().toUpperCase()
      if (!VALID_COMMISSION_STATUSES.has(commissionStatus)) return NextResponse.json({ error: "Invalid commission status" }, { status: 400 })
      data.commissionStatus = commissionStatus
    }

    if (body.qualityFlag !== undefined) {
      // null is the explicit "clear the flag" value, so it is allowed through;
      // any other non-string is a malformed field, not a clear.
      if (body.qualityFlag !== null && typeof body.qualityFlag !== "string") return NextResponse.json({ error: "Invalid quality flag" }, { status: 400 })
      const qualityFlag = (body.qualityFlag ?? "").trim().toUpperCase()
      if (!VALID_QUALITY_FLAGS.has(qualityFlag)) return NextResponse.json({ error: "Invalid quality flag" }, { status: 400 })
      data.qualityFlag = qualityFlag || null
    }

    // This route records a DECISION, and a decision must actually CHANGE the
    // commission status or the quality flag.
    //
    // Presence is NOT enough, and testing only for presence was the first
    // version of this guard. It closed `PATCH {decisionNote}` alone but left the
    // same hole one step away: echoing the row's CURRENT status back
    // (`{commissionStatus: "BLOCKED"}` on an already-BLOCKED row) satisfied the
    // presence check while changing nothing, and still rewrote
    // metadata.lastDecision.note — the reason the queue displays for why an
    // agent's money was withheld — and still minted a
    // REFERRAL_EVENT_DECIDED audit row whose oldValue and newValue
    // were identical. Verified by reproduction, not reasoning.
    //
    // Comparing against `existing` closes both doors with one rule: a no-op is
    // not a decision, however it is spelled.
    const statusChanges = data.commissionStatus !== undefined && data.commissionStatus !== existing.commissionStatus
    const flagChanges = data.qualityFlag !== undefined && data.qualityFlag !== existing.qualityFlag
    if (!statusChanges && !flagChanges) {
      // Names the current state so the caller can see why it was a no-op rather
      // than guessing. Re-affirming a decision is not a decision; correcting a
      // recorded reason is deliberately not possible through this route.
      return NextResponse.json(
        {
          error: `No change: this event is already ${existing.commissionStatus}${existing.qualityFlag ? ` / ${existing.qualityFlag}` : ""}. A decision must change the commission status or quality flag.`,
        },
        { status: 400 },
      )
    }

    const decisionNote = cleanNullable(body.decisionNote, 500)

    // A commissionStatus/qualityFlag change is a decision to release or withhold
    // an agent's money, and AuditLog.newValue.decisionNote is the only durable
    // record of why. The panel enforces this client-side, but the route is the
    // control: without this, a caller could decide with no stated reason at all
    // (a missing note made cleanNullable return undefined, which skipped
    // lastDecision entirely while the status change still landed).
    //
    // Unconditional now — the guard above has already established that this IS a
    // decision, so there is no longer a case where a note is optional.
    if (!decisionNote) {
      return NextResponse.json({ error: "A decision note is required when changing commission status or quality flag." }, { status: 400 })
    }

    const priorMetadata = existing.metadata && typeof existing.metadata === "object" && !Array.isArray(existing.metadata)
      ? (existing.metadata as Record<string, unknown>)
      : {}
    // The note this decision replaces, so the audit row records what was
    // overwritten rather than only what it became.
    // !Array.isArray for the same reason as the line above. An array is
    // typeof "object", and JSON cannot give one a `note` property so this is not
    // exploitable — but the two checks guarding the same blob should not differ,
    // or the next reader has to work out whether the difference was deliberate.
    const priorDecision = priorMetadata.lastDecision && typeof priorMetadata.lastDecision === "object" && !Array.isArray(priorMetadata.lastDecision)
      ? (priorMetadata.lastDecision as { note?: unknown })
      : null
    const priorNote = typeof priorDecision?.note === "string" ? priorDecision.note : null

    // `!== undefined`, NOT `??`. null is a legitimate value for qualityFlag —
    // it IS the cleared state — and `??` treated it as "not supplied", so
    // clearing a flag wrote null to the column while metadata.lastDecision
    // still claimed the OLD flag. The displayed decision then contradicted the
    // row it described.
    const nextCommissionStatus = data.commissionStatus !== undefined ? data.commissionStatus : existing.commissionStatus
    const nextQualityFlag = data.qualityFlag !== undefined ? data.qualityFlag : existing.qualityFlag

    data.metadata = {
      ...priorMetadata,
      lastDecision: {
        note: decisionNote,
        byUserId: guard.user.id,
        byEmail: guard.user.email,
        at: new Date().toISOString(),
        commissionStatus: nextCommissionStatus,
        qualityFlag: nextQualityFlag,
      },
    }

    // Guard against un-reversing a clawback: reverseReferralCommissionForLoan (the
    // DPD/default cron) can flip commissionStatus to REVERSED between this route's
    // findFirst and update, so the guard must be atomic — condition in the updateMany
    // where, not a separate read check.
    const result = await prisma.referralEvent.updateMany({
      where: { id, tenantId: tenant.id, commissionStatus: { not: "REVERSED" } },
      data,
    })
    if (result.count === 0) {
      return NextResponse.json({ error: "Commission has been reversed and can no longer be modified." }, { status: 400 })
    }

    const updated = { ...existing, ...data }
    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: "REFERRAL_EVENT_DECIDED",
      entity: "ReferralEvent",
      entityId: id,
      oldValue: { commissionStatus: existing.commissionStatus, qualityFlag: existing.qualityFlag, decisionNote: priorNote },
      newValue: { commissionStatus: updated.commissionStatus, qualityFlag: updated.qualityFlag, decisionNote },
    })

    return NextResponse.json(updated)
  })
}
