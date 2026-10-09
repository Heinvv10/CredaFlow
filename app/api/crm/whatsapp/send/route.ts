import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { prisma } from "@/lib/prisma"
import { withTenantContext } from "@/lib/tenant"
import {
  KnownDispatchPersistenceError,
  knownDispatchEvidenceFromError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
  type KnownDispatchEvidence,
} from "@/lib/messaging/send"
import { getOrCreateAgentMessageTemplate } from "@/lib/messaging/agent-message-template"
import { parseMessageOperationId } from "@/lib/messaging/request-idempotency"

interface SendBody {
  // clientId (post-conversion) or leadId (pre-conversion lead, no Client
  // row yet) — the Contact lookup below handles both.
  clientId?: string
  leadId?: string
  message: string
  operationId?: unknown
}

export async function POST(req: NextRequest) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const body: SendBody = await req.json()
      if ((!body.clientId && !body.leadId) || !body.message?.trim()) {
        return NextResponse.json({ error: "clientId or leadId, and message, are required" }, { status: 422 })
      }
      const operationId = parseMessageOperationId(body.operationId)
      if (!operationId) {
        return NextResponse.json({ error: "operationId is required" }, { status: 400 })
      }

      const tenantId = tenant.id

      const contact = body.clientId
        ? await prisma.contact.findFirst({ where: { tenantId, clientId: body.clientId } })
        : await prisma.contact.findFirst({ where: { tenantId, leadId: body.leadId } })

      if (!contact) {
        return NextResponse.json({ error: "No comms record on file for this recipient" }, { status: 404 })
      }

      const toValue = contact.primaryWaJid ?? contact.primaryPhone
      if (!toValue) {
        return NextResponse.json({ error: "No WhatsApp number or phone on file" }, { status: 422 })
      }

      const template = await getOrCreateAgentMessageTemplate(tenantId, "WHATSAPP")

      let result
      let reconciliationRequired = false
      let knownDispatchEvidence: KnownDispatchEvidence | undefined
      try {
        result = await sendMessage({
          contactId: contact.id,
          channel: "WHATSAPP",
          template,
          vars: { body: body.message },
          toValue,
          createdById: guard.user.id,
          category: "manual_whatsapp",
          idempotencyKey: `manual-whatsapp:${contact.id}:${operationId}`,
        })
      } catch (err) {
        if (err instanceof SendBlockedError) {
          return NextResponse.json({ error: `Message blocked: ${err.reason}` }, { status: 422 })
        }
        if (err instanceof KnownDispatchPersistenceError) {
          result = err.messageRecord
          reconciliationRequired = true
          knownDispatchEvidence = knownDispatchEvidenceFromError(err)
        } else if (err instanceof MessageReconciliationRequiredError) {
          result = err.messageRecord
          reconciliationRequired = true
        } else {
          // The WhatsApp channel being globally disabled (WA_ENABLED=false —
          // see lib/whatsapp.ts's sendWhatsAppMessage) is an eligibility-class
          // condition exactly like a consent block: nothing the officer does
          // will make a retry succeed right now, so it deserves the same 4xx
          // treatment as SendBlockedError above, not a 500 that reads as "the
          // server broke." Matches the message text lib/messaging/retry.ts
          // already keys off to classify this failure as PERMANENT.
          if (err instanceof Error && /whatsapp\s+disabled/i.test(err.message)) {
            return NextResponse.json({ error: err.message }, { status: 422 })
          }
          return NextResponse.json({ error: err instanceof Error ? err.message : "Failed to send" }, { status: 500 })
        }
      }

      const simulated = result.status === "SIMULATED"
      const sent = ["SENT", "DELIVERED", "READ"].includes(result.status)
      const pending = ["QUEUED", "RETRYING"].includes(result.status) && !reconciliationRequired
      const notSent = ["FAILED", "FAILED_PERMANENT", "BOUNCED", "EXPIRED", "SUPPRESSED_BY_CONSENT"].includes(result.status)

      // Log as CRM activity if this recipient has a lead (converted-client
      // flow looks the lead up by convertedToClientId; the pre-conversion
      // flow already has the leadId from the request body).
      const leadId = body.leadId ?? (body.clientId
        ? (await prisma.lead.findFirst({
            where: { convertedToClientId: body.clientId, tenantId },
            select: { id: true },
          }))?.id
        : undefined)

      if (leadId) {
        await prisma.crmActivity.create({
          data: {
            tenantId,
            leadId,
            clientId: body.clientId,
            type: "WHATSAPP",
            subject: reconciliationRequired
              ? `WA outcome requires reconciliation; do not resend (${result.id})`
              : simulated
                ? `WA simulated (not sent) by ${guard.user.name ?? guard.user.email ?? "agent"}`
                : sent
                  ? `WA sent by ${guard.user.name ?? guard.user.email ?? "agent"}`
                  : notSent
                    ? `WA not sent (${result.status}; ${result.id})`
                    : `WA queued/retrying; do not duplicate (${result.id})`,
            notes: body.message.slice(0, 200),
            createdById: guard.user.id,
          },
        }).catch(() => {})
      }

      if (notSent) {
        return NextResponse.json({
          ok: false,
          messageId: result.id,
          error: `The reserved WhatsApp attempt is ${result.status}; review it before creating a new message.`,
        }, { status: 409 })
      }

      return NextResponse.json({
        ok: true,
        messageId: result.id,
        simulated,
        sent,
        pending,
        reconciliationRequired,
        knownDispatchEvidence,
      }, { status: pending ? 202 : 200 })
    } catch {
      return NextResponse.json({ error: "Failed to send WhatsApp" }, { status: 500 })
    }
  })
}
