import { NextRequest, NextResponse } from "next/server"
import { z } from "zod"
import { requireCommsAgent } from "@/lib/inbox/authz"
import { withTenantContext } from "@/lib/tenant"
import { dispatchAgentReply } from "@/lib/inbox/dispatch"
import { parseMessageOperationId } from "@/lib/messaging/request-idempotency"

export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const guard = await requireCommsAgent()
  if (guard.error) return guard.error
  const { id } = await ctx.params
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
    const result = await dispatchAgentReply({ tenantId: tenant.id, conversationId: id, agentUserId: guard.user.id, agentEmail: guard.user.email, text, channel, operationId })
    if (result.ok) return NextResponse.json({
      ok: true,
      message: result.message,
      outcome: result.outcome,
      reconciliationRequired: result.reconciliationRequired === true,
      knownDispatchEvidence: result.knownDispatchEvidence,
    })
    if (result.reason === "CONVERSATION_NOT_FOUND") return NextResponse.json({ ok: false, reason: result.reason }, { status: 404 })
    // Soft failures — 200 so the UI can offer the SMS/email fallback CTA.
    return NextResponse.json({ ok: false, reason: result.reason, detail: result.detail })
  })
}
