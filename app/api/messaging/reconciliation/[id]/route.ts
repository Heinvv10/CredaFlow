import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import {
  MessageReconciliationConflictError,
  MessageReconciliationEvidenceError,
  reconcileHeldMessage,
  type MessageReconciliationOutcome,
} from "@/lib/messaging/reconcile-held-message"

type RouteContext = { params: Promise<{ id: string }> }
const OUTCOMES = new Set<MessageReconciliationOutcome>(["SENT", "SIMULATED", "NOT_SENT"])

export async function POST(req: NextRequest, { params }: RouteContext) {
  const guard = await requireApiRole("LOAN_ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    let body: {
      outcome?: MessageReconciliationOutcome
      reason?: string
      evidenceReference?: string
      providerMessageId?: string
      providerAcceptedAt?: string
      simulationReceiptId?: string
    }
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }

    const outcome = body.outcome
    const reason = body.reason?.trim() ?? ""
    if (!outcome || !OUTCOMES.has(outcome) || reason.length < 10 || reason.length > 2_000) {
      return NextResponse.json(
        { error: "outcome (SENT, SIMULATED or NOT_SENT) and a 10-2000 character reason are required" },
        { status: 422 },
      )
    }

    const evidenceReference = body.evidenceReference?.trim() ?? ""
    if (
      evidenceReference.length < 3 ||
      evidenceReference.length > 512 ||
      /[\u0000-\u001F\u007F]/.test(evidenceReference)
    ) {
      return NextResponse.json(
        { error: "evidenceReference must be 3-512 characters without control characters for every outcome" },
        { status: 422 },
      )
    }

    const providerMessageId = body.providerMessageId?.trim() ?? ""
    if (
      providerMessageId &&
      (providerMessageId.length > 512 || /[\u0000-\u001F\u007F]/.test(providerMessageId))
    ) {
      return NextResponse.json(
        { error: "providerMessageId must be at most 512 characters without control characters" },
        { status: 422 },
      )
    }
    if (outcome !== "SENT" && providerMessageId) {
      return NextResponse.json(
        { error: "providerMessageId is valid only for a SENT outcome" },
        { status: 422 },
      )
    }

    const simulationReceiptId = body.simulationReceiptId?.trim() ?? ""
    if (
      simulationReceiptId &&
      (simulationReceiptId.length > 512 || /[\u0000-\u001F\u007F]/.test(simulationReceiptId))
    ) {
      return NextResponse.json(
        { error: "simulationReceiptId must be at most 512 characters without control characters" },
        { status: 422 },
      )
    }
    if (outcome !== "SIMULATED" && simulationReceiptId) {
      return NextResponse.json(
        { error: "simulationReceiptId is valid only for a SIMULATED outcome" },
        { status: 422 },
      )
    }

    let providerAcceptedAt: Date | undefined
    const rawTimestamp = body.providerAcceptedAt?.trim() ?? ""
    if (rawTimestamp) {
      if (outcome !== "SENT") {
        return NextResponse.json(
          { error: "providerAcceptedAt is valid only for a SENT outcome" },
          { status: 422 },
        )
      }
      const hasExplicitTimezone = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(rawTimestamp)
      providerAcceptedAt = new Date(rawTimestamp)
      if (!hasExplicitTimezone || !Number.isFinite(providerAcceptedAt.getTime())) {
        return NextResponse.json(
          { error: "providerAcceptedAt must be a valid ISO timestamp with Z or an explicit timezone offset" },
          { status: 422 },
        )
      }
      if (providerAcceptedAt.getTime() > Date.now()) {
        return NextResponse.json({ error: "providerAcceptedAt cannot be in the future" }, { status: 422 })
      }
    }

    const { id: messageId } = await params
    try {
      await reconcileHeldMessage({
        tenantId: tenant.id,
        messageId,
        outcome,
        reason,
        evidenceReference,
        ...(providerMessageId ? { providerMessageId } : {}),
        ...(providerAcceptedAt ? { providerAcceptedAt } : {}),
        ...(simulationReceiptId ? { simulationReceiptId } : {}),
        userId: guard.user.id,
        userEmail: guard.user.email,
      })
      return NextResponse.json({ ok: true, messageId, outcome })
    } catch (error) {
      if (error instanceof MessageReconciliationConflictError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      if (error instanceof MessageReconciliationEvidenceError) {
        return NextResponse.json({ error: error.message }, { status: 422 })
      }
      throw error
    }
  })
}
