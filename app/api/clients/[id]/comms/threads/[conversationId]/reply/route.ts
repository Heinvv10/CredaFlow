import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { dispatchAgentReply } from "@/lib/inbox/dispatch"
import { parseMessageOperationId } from "@/lib/messaging/request-idempotency"

// Any-staff (READONLY) free-text reply from the client Comms tab. Matches the
// message-client drawer's access model; ownership is enforced below so a staffer
// can only reply into a conversation that belongs to THIS client's contact.
// /inbox keeps its own requireCommsAgent route — this does not touch it.
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string; conversationId: string }> }) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const { id: clientId, conversationId } = await ctx.params
  const body = (await req.json()) as { text?: string; operationId?: unknown; channel?: unknown }
  const text = (body.text ?? "").trim()
  if (text === "") return NextResponse.json({ error: "text is required" }, { status: 400 })
  const operationId = parseMessageOperationId(body.operationId)
  if (!operationId) return NextResponse.json({ error: "operationId is required" }, { status: 400 })

  // One thread carries every channel now, so the composer says which one this
  // reply rides. Absent = the server's own default (latest inbound channel).
  const channelSchema = z.enum(["WHATSAPP", "EMAIL"]).optional()
  const channelParsed = channelSchema.safeParse(body.channel ?? undefined)
  if (!channelParsed.success) {
    return NextResponse.json({ error: "channel must be WHATSAPP or EMAIL" }, { status: 400 })
  }
  const channel = channelParsed.data

  return withTenantContext(req, async (tenant) => {
    const client = await prisma.client.findFirst({
      where: { id: clientId, tenantId: tenant.id },
      include: { contact: true },
    })
    if (!client || !client.contact) {
      return NextResponse.json({ error: "client has no contact" }, { status: 400 })
    }

    // Ownership: the conversation must belong to this client's contact.
    const owned = await prisma.conversation.findFirst({
      where: { id: conversationId, tenantId: tenant.id, contactId: client.contact.id },
      select: { id: true },
    })
    if (!owned) return NextResponse.json({ error: "conversation not found" }, { status: 404 })

    const result = await dispatchAgentReply({ tenantId: tenant.id, conversationId, agentUserId: guard.user.id, text, channel, operationId })
    if (result.ok) return NextResponse.json({
      ok: true,
      message: result.message,
      outcome: result.outcome,
      reconciliationRequired: result.reconciliationRequired === true,
      knownDispatchEvidence: result.knownDispatchEvidence,
    })
    if (result.reason === "CONVERSATION_NOT_FOUND") return NextResponse.json({ ok: false, reason: result.reason }, { status: 404 })
    // Soft failures — 200 so the composer can show its fallback CTA.
    return NextResponse.json({ ok: false, reason: result.reason, detail: result.detail })
  })
}
