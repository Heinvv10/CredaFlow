import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import {
  KnownDispatchPersistenceError,
  knownDispatchEvidenceFromError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
} from "@/lib/messaging/send"
import { getOrCreateAgentMessageTemplate } from "@/lib/messaging/agent-message-template"
import { AuditAction, logAudit } from "@/lib/audit"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { parseMessageOperationId } from "@/lib/messaging/request-idempotency"
import { messageDeliveryOutcome } from "@/lib/messaging/delivery-outcome"
import { isSmsChannelEnabled, SMS_CHANNEL_OFF_REASON } from "@/lib/messaging/sms-channel"
import {
  reminderDeliverySummary,
  type ReminderChannel,
  type ReminderDelivery,
} from "@/lib/collections/manual-reminder-outcome"
import { EntityBorrowerError, hasClientBorrower } from "@/lib/borrower"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ loanId: string }> }
) {
  const guard = await requireApiRole("COLLECTIONS_OFFICER")
  if (guard.error) return guard.error
  const session = { user: guard.user }

  return withTenantContext(req, async (tenant) => {
    const { loanId } = await params
    const body = await req.json()
    const { channel, message } = body as {
      channel: "sms" | "whatsapp" | "both"
      message: string
      operationId?: unknown
    }
    const operationId = parseMessageOperationId(body.operationId)

    if (!(["sms", "whatsapp", "both"] as const).includes(channel)) {
      return NextResponse.json({ error: "channel must be sms, whatsapp, or both" }, { status: 400 })
    }
    if (!message?.trim()) {
      return NextResponse.json({ error: "Message is required" }, { status: 400 })
    }
    if (!operationId) {
      return NextResponse.json({ error: "operationId is required" }, { status: 400 })
    }

    const loan = await prisma.loan.findUnique({
      where: { id: loanId, tenantId: tenant.id },
      include: { client: { select: { id: true, phone: true, whatsapp: true, firstName: true, lastName: true } } },
    })
    if (!loan) return NextResponse.json({ error: "Loan not found" }, { status: 404 })
    // A reminder messages a natural person (the Client's phone / WhatsApp):
    // an entity borrower (asset finance) has no Client to message. Its regime
    // is not the reason.
    if (!hasClientBorrower(loan)) {
      return NextResponse.json({ error: new EntityBorrowerError().message }, { status: 409 })
    }

    // Collections/dunning reminders are for accounts with arrears to collect —
    // never dun a settled R0 account. Also gate on
    // outstandingPrincipal so a fully-repaid loan carrying stale arrears isn't
    // chased (audit N-03/N-05). The error copy must stay byte-identical across
    // all three dunning-gate routes (see
    // app/api/loans/[id]/collections-stage/route.ts and
    // app/api/loans/section129/route.ts) and must be accurate for EVERY leg
    // of this OR — including the pure arrearsAmount<=0 leg, where the loan is
    // CURRENT (principal still outstanding, just not in arrears right now),
    // not settled and not "nothing outstanding."
    const collectionsEligibility = evaluateCollectionsEligibility(loan, "DUNNING")
    if (!collectionsEligibility.eligible) {
      return NextResponse.json(
        { error: `Cannot send a collections reminder: ${collectionsEligibility.reason}.` },
        { status: 422 }
      )
    }

    const phone = loan.client.phone
    const waNumber = loan.client.whatsapp ?? phone
    const deliveries: ReminderDelivery[] = []

    // Rerouted through sendMessage() (previously called bulksms directly
    // with no consent/quiet-hours gating — tracked follow-up B3b-reroute).
    // INTENTIONAL behavior change: a reminder that would previously always
    // fire can now be blocked by consent/eligibility. That's surfaced below,
    // never as a fake success.
    const contact = await prisma.contact.findFirst({ where: { tenantId: tenant.id, clientId: loan.client.id } })

    async function sendOn(ch: "SMS" | "WHATSAPP", toValue: string, label: ReminderChannel): Promise<void> {
      if (!contact) {
        deliveries.push({ channel: label, outcome: "failed", detail: "no comms Contact on file for this client" })
        return
      }
      try {
        const template = await getOrCreateAgentMessageTemplate(tenant.id, ch)
        const result = await sendMessage({
          contactId: contact.id,
          channel: ch,
          template,
          vars: { body: message },
          toValue,
          createdById: guard.user?.id,
          category: "manual_reminder",
          loanId,
          idempotencyKey: `manual-reminder:${loanId}:${operationId}:${ch}`,
        })
        const outcome = messageDeliveryOutcome(result.status)
        deliveries.push({
          channel: label,
          outcome: outcome === "not_sent" ? "failed" : outcome,
          messageId: result.id,
          ...(outcome === "not_sent"
            ? { detail: `prior attempt is ${result.status}; review this message before creating a new reminder` }
            : {}),
        })
      } catch (err) {
        if (err instanceof SendBlockedError) {
          deliveries.push({ channel: label, outcome: "blocked", detail: err.reason })
        } else if (err instanceof KnownDispatchPersistenceError) {
          deliveries.push({
            channel: label,
            outcome: "reconciliation_required",
            messageId: err.messageRecord.id,
            knownDispatchEvidence: knownDispatchEvidenceFromError(err),
          })
        } else if (err instanceof MessageReconciliationRequiredError) {
          deliveries.push({ channel: label, outcome: "reconciliation_required", messageId: err.messageRecord.id })
        } else {
          deliveries.push({ channel: label, outcome: "failed", detail: err instanceof Error ? err.message : String(err) })
        }
      }
    }

    if (channel === "sms" || channel === "both") {
      // SMS channel off (BULKSMS_DRY_RUN). Record it exactly as any other
      // blocked channel so the LoanNote and the response say the reminder did
      // NOT go out over SMS, rather than dispatching a leg that can only
      // produce a SIMULATED Message row. `both` still sends the WhatsApp leg.
      if (!isSmsChannelEnabled()) {
        deliveries.push({ channel: "SMS", outcome: "blocked", detail: SMS_CHANNEL_OFF_REASON })
      } else {
        await sendOn("SMS", contact?.primaryPhone ?? phone, "SMS")
      }
    }
    if (channel === "whatsapp" || channel === "both") {
      await sendOn("WHATSAPP", contact?.primaryWaJid ?? contact?.primaryPhone ?? waNumber, "WhatsApp")
    }

    const officer = session.user?.email ?? "system"
    const deliverySummary = reminderDeliverySummary(deliveries)
    const note = `Manual reminder requested by ${officer}. Outcomes: ${deliverySummary}. Message: "${message}"`

    const channelsSent = deliveries.filter((item) => item.outcome === "sent").map((item) => item.channel)
    const channelsSimulated = deliveries.filter((item) => item.outcome === "simulated").map((item) => item.channel)
    const channelsPending = deliveries.filter((item) => item.outcome === "pending").map((item) => item.channel)
    const reconciliationMessages = deliveries
      .filter((item) => item.outcome === "reconciliation_required")
      .map((item) => ({ channel: item.channel, messageId: item.messageId! }))
    const errors = deliveries
      .filter((item) => item.outcome === "blocked" || item.outcome === "failed")
      .map((item) => `${item.channel}: ${item.outcome}${item.detail ? ` — ${item.detail}` : ""}`)

    await prisma.loanNote.create({
      data: {
        tenantId: tenant.id,
        loanId,
        type: "manual_reminder",
        note,
        createdBy: officer,
      },
    })

    // Audit trail: outbound debtor communication must be recorded, including
    // the reason for any block/failure now that sendMessage() can refuse.
    await logAudit({
      tenantId: tenant.id,
      userId: guard.user?.id,
      userEmail: session.user?.email ?? undefined,
      action: AuditAction.REMINDER_DISPATCH_RECORDED,
      entity: "Loan",
      entityId: loanId,
      newValue: {
        channelRequested: channel,
        deliveries,
        deliverySummary,
        channelsSent,
        channelsSimulated,
        channelsPending,
        reconciliationMessages,
        hadErrors: errors.length > 0,
        allFailed:
          channelsSent.length === 0 &&
          channelsSimulated.length === 0 &&
          channelsPending.length === 0 &&
          reconciliationMessages.length === 0,
        errors: errors.length > 0 ? errors : undefined,
      },
    })

    if (
      errors.length > 0 &&
      channelsSent.length === 0 &&
      channelsSimulated.length === 0 &&
      channelsPending.length === 0 &&
      reconciliationMessages.length === 0
    ) {
      // Pure eligibility/consent blocks are client-actionable 4xx responses;
      // preparation/provider failures remain 502 responses.
      const status = deliveries.some((item) => item.outcome === "failed") ? 502 : 422
      return NextResponse.json({ ok: false, deliveries, error: errors.join("; ") }, { status })
    }

    if (channelsPending.length > 0 && channelsSent.length === 0 && channelsSimulated.length === 0) {
      return NextResponse.json({
        ok: true,
        deliveries,
        channels: channelsSent,
        simulatedChannels: channelsSimulated,
        pendingChannels: channelsPending,
        reconciliationRequired: reconciliationMessages.length > 0,
        reconciliationMessages,
        errors: errors.length > 0 ? errors : undefined,
      }, { status: 202 })
    }

    return NextResponse.json({
      ok: true,
      deliveries,
      channels: channelsSent,
      simulatedChannels: channelsSimulated,
      pendingChannels: channelsPending,
      reconciliationRequired: reconciliationMessages.length > 0,
      reconciliationMessages,
      errors: errors.length > 0 ? errors : undefined,
    })
  })
}
