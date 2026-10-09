import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { sendLeadOutreach } from "@/lib/crm/lead-outreach"
import { isLeadOutreachKind, isOutreachChannel } from "@/lib/crm/lead-outreach-templates"
import { logAudit, AuditAction } from "@/lib/audit"
import { parseMessageOperationId } from "@/lib/messaging/request-idempotency"

type Body = { kind?: unknown; channel?: unknown; operationId?: unknown }

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // READONLY floor mirrors the free-text sibling (messages/route.ts): any staff
  // who can view the record may message it. Consent/blocked/audit gates live
  // in sendMessage. Do not tighten without a new product decision.
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  const { id: leadId } = await ctx.params
  const body = (await req.json()) as Body

  if (!isLeadOutreachKind(body.kind)) {
    return NextResponse.json({ error: "invalid kind" }, { status: 400 })
  }
  if (!isOutreachChannel(body.channel)) {
    return NextResponse.json({ error: "invalid channel" }, { status: 400 })
  }
  const { kind, channel } = body
  const operationId = parseMessageOperationId(body.operationId)
  if (!operationId) {
    return NextResponse.json({ error: "operationId is required" }, { status: 400 })
  }

  return withTenantContext(req, async (tenant) => {
    const result = await sendLeadOutreach({
      tenantId: tenant.id,
      leadId,
      kind,
      channel,
      agentUserId: guard.user.id,
      // Signs the message so the lead knows who they are talking to.
      // agentDisplayName reduces this to a first name (and never the email).
      agentFullName: guard.user.name,
      operationId,
    })

    if (!result.ok) {
      // A refusal is itself worth recording: "who tried to contact this person
      // and was stopped" is exactly what a regulator asks about an opted-out
      // data subject. The success row below is a different action.
      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: AuditAction.LEAD_OUTREACH_BLOCKED,
        entity: "Lead",
        entityId: leadId,
        newValue: { kind, channel, reason: result.reason, detail: result.detail },
      })
      // 400 for structural problems (mirrors the messages/ sibling), 409 for a
      // record that exists but may not be contacted right now.
      const status = result.reason === "NO_CONTACT" ? 400 : 409
      return NextResponse.json({ reason: result.reason, detail: result.detail }, { status })
    }

    const sent = result.outcome === "sent"
    const simulated = result.outcome === "simulated"
    const pending = result.outcome === "pending"
    const notSent = result.outcome === "not_sent"
    const reconciliationRequired = result.outcome === "reconciliation_required"

    // The Message row itself carries the lawful basis; this records the staff
    // *action* against the Lead so the CRM audit trail shows who reached out
    // and with what, without opening the comms tables.
    void logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: reconciliationRequired
        ? AuditAction.LEAD_OUTREACH_RECONCILIATION_REQUIRED
        : simulated
          ? AuditAction.LEAD_OUTREACH_SIMULATED
          : pending
            ? AuditAction.LEAD_OUTREACH_PENDING
            : notSent
              ? AuditAction.LEAD_OUTREACH_NOT_SENT
              : AuditAction.LEAD_OUTREACH_SENT,
      entity: "Lead",
      entityId: leadId,
      newValue: {
        kind,
        channel,
        messageId: result.messageId,
        messageStatus: result.status,
        outcome: result.outcome,
        sent,
        simulated,
        pending,
        reconciliationRequired,
        knownDispatchEvidence: result.knownDispatchEvidence,
      },
    })

    if (notSent) {
      return NextResponse.json({
        reason: "SEND_FAILED",
        detail: `The reserved outreach attempt is ${result.status}; review it before creating a new message.`,
        messageId: result.messageId,
        terminal: true,
      }, { status: 409 })
    }

    return NextResponse.json({
      messageId: result.messageId,
      conversationId: result.conversationId,
      sent,
      simulated,
      pending,
      reconciliationRequired,
      knownDispatchEvidence: result.knownDispatchEvidence,
    }, { status: pending ? 202 : 200 })
  })
}
