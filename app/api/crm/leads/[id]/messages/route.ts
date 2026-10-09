import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { sendAgentMessage } from "@/lib/messaging/agent-message"
import type { EmailAttachment } from "@/lib/email/service"
import { parseMessageOperationId } from "@/lib/messaging/request-idempotency"

// Attachments arrive over the wire as base64 JSON (drawer reads the file
// client-side via FileReader) — not the Buffer-based EmailAttachment shape
// sendAgentMessage/sendMessage expect. Decode below before forwarding.
type WireAttachment = { filename: string; contentType: string; contentBase64: string }

type Body = {
  channel?: "EMAIL" | "WHATSAPP" | "SMS"
  text?: string
  subject?: string
  attachments?: WireAttachment[]
  operationId?: string
}

function isValidChannel(c: unknown): c is "EMAIL" | "WHATSAPP" | "SMS" {
  return c === "EMAIL" || c === "WHATSAPP" || c === "SMS"
}

// Server-side attachment cap. The drawer already enforces this client-side,
// but the client cap is not authoritative — a modified request could send
// past it.
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024
const MAX_ATTACHMENT_COUNT = 5

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  // READONLY floor is DELIBERATE (spec Decision 1 of #334, reaffirmed by Hein
  // 2026-07-13 after blind-review challenge): any staff who can view the
  // record may message it. Consent/blocked/audit gates live in
  // sendAgentMessage → sendMessage. Do not tighten to isCommsAgent (the
  // /inbox gate) without a new product decision.
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const { id: leadId } = await ctx.params
  const body = (await req.json()) as Body
  const text = (body.text ?? "").trim()
  if (text === "") return NextResponse.json({ error: "text is required" }, { status: 400 })
  if (!isValidChannel(body.channel)) {
    return NextResponse.json({ error: "invalid channel" }, { status: 400 })
  }
  const channel = body.channel
  const operationId = parseMessageOperationId(body.operationId)
  if (!operationId) return NextResponse.json({ error: "operationId is required" }, { status: 400 })

  const attachments: EmailAttachment[] | undefined = body.attachments?.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    content: Buffer.from(a.contentBase64, "base64"),
  }))

  if (attachments) {
    const totalBytes = attachments.reduce((sum, a) => sum + a.content.length, 0)
    if (attachments.length > MAX_ATTACHMENT_COUNT || totalBytes > MAX_ATTACHMENT_BYTES) {
      return NextResponse.json({ error: "attachments too large" }, { status: 400 })
    }
  }

  return withTenantContext(req, async (tenant) => {
    const lead = await prisma.lead.findFirst({ where: { id: leadId, tenantId: tenant.id }, include: { contact: true } })
    if (!lead || !lead.contact) {
      return NextResponse.json({ error: "lead has no contact" }, { status: 400 })
    }

    const result = await sendAgentMessage({
      tenantId: tenant.id,
      contactId: lead.contact.id,
      channel,
      text,
      subject: body.subject,
      attachments,
      agentUserId: guard.user.id,
      operationId,
    })

    if (result.ok) {
      return NextResponse.json({
        messageId: result.messageId,
        conversationId: result.conversationId,
        status: result.status,
        outcome: result.outcome,
        reconciliationRequired: result.reconciliationRequired === true,
        knownDispatchEvidence: result.knownDispatchEvidence,
      })
    }
    return NextResponse.json({ reason: result.reason, detail: result.detail }, { status: 409 })
  })
}
