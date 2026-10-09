import { NextRequest, NextResponse } from "next/server"
import { logAudit } from "@/lib/audit"
import { findLenderIdentity } from "@/lib/config/identity"
import { callerIp, checkRateLimit } from "@/lib/rate-limit"
import { getTenantFromRequest } from "@/lib/tenant"
import { runWithTenant } from "@/lib/tenant-scope"
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/website-chat/constants"
import { notifyStaffOfHandoff } from "@/lib/website-chat/handoff"
import { readJsonObject, safeErrorInfo } from "@/lib/website-chat/http"
import { knowledgeFor } from "@/lib/website-chat/knowledge"
import type { ChatMode } from "@/lib/website-chat/mode"
import { askAssistant, type AssistantResult, type HandoffReason } from "@/lib/website-chat/model"
import { buildSystemPrompt } from "@/lib/website-chat/prompt"
import { chatBotsEnabled } from "@/lib/website-chat/settings"
import { loadChat, recordAssistantReply, recordVisitorMessage, recordVisitorMessageToStaff } from "@/lib/website-chat/store"
import { isChatConfigured, verifyChatToken } from "@/lib/website-chat/token"
import { cleanChatText } from "@/lib/website-chat/validate"

const MESSAGE_RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 } as const
const BAD_TOKEN_RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 } as const
const UNAVAILABLE = { error: "The chat is not available right now. Please WhatsApp or call us." }
const EXPIRED = { error: "This chat session has expired. Please start a new chat." }
const STAFF_LIMIT = "You've reached the message limit for this chat. The consultant can still reply."
const FALLBACK_LIMIT = "You've reached the message limit for this chat. Please use the WhatsApp button or wait for our call."
const ended = () => NextResponse.json({ error: "This chat has ended. A consultant will be in touch if you asked for a call." }, { status: 409 })

function tooMany(retryAfterSeconds: number) {
  return NextResponse.json({ error: "You're sending messages too quickly. Please wait a moment." }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } })
}

/**
 * The chat as it is now, for a request whose first read went stale: staff joined, or
 * another request won the hand-off, while this one was in flight. Never guessed.
 */
async function current(tenantId: string, conversationId: string): Promise<{ mode: ChatMode; staffName: string | null }> {
  const chat = await loadChat(tenantId, conversationId)
  return { mode: chat?.mode ?? "ended", staffName: chat?.staffFirstName ?? null }
}

type BotReply = { tenantId: string; conversationId: string; ip: string; reply: string; needsHuman: boolean; reason: HandoffReason | null; was: ChatMode; handoffOnly?: boolean }

/**
 * Writes the assistant's reply and says what to tell the visitor. `suppressed` means the
 * reply was not written (staff hold the chat, or it is waiting for them): show the chat
 * as it is now and no reply.
 *
 * Only the call that flipped the status audits the hand-off and rings staff. The wait
 * is already open by then (the row is written with the flip), so a bell that fails is
 * logged and loses nothing else.
 */
async function sendBotReply(a: BotReply): Promise<{ suppressed: true; mode: ChatMode; staffName: string | null } | { suppressed: false; mode: ChatMode; reply: string }> {
  const { tenantId, conversationId } = a
  const now = new Date()
  const sent = await recordAssistantReply({ tenantId, conversationId, reply: a.reply, needsHuman: a.needsHuman, reason: a.reason, now, handoffOnly: a.handoffOnly })
  if (sent.suppressed) return { suppressed: true, ...(await current(tenantId, conversationId)) }
  if (sent.handedOffNow) {
    await logAudit({ tenantId, action: "WEBSITE_CHAT_HANDOFF", entity: "Conversation", entityId: conversationId, ipAddress: a.ip, newValue: { reason: a.reason ?? "out_of_scope" } })
    try {
      await notifyStaffOfHandoff({ tenantId, conversationId, now })
    } catch (error) {
      console.error("[website/chat/message] notifyStaffOfHandoff failed:", safeErrorInfo(error))
    }
    return { suppressed: false, mode: sent.mode, reply: sent.reply }
  }
  // A hand-off another request won while this one read "bot": the mode is read again, not guessed.
  const stale = a.needsHuman && a.was === "bot"
  return { suppressed: false, mode: stale ? (await current(tenantId, conversationId)).mode : a.was, reply: sent.reply }
}

export async function POST(req: NextRequest) {
  try {
    const ip = callerIp(req)
    const tenant = await getTenantFromRequest(req)
    if (!tenant || !isChatConfigured() || !(await chatBotsEnabled(tenant.id))) {
      return NextResponse.json(UNAVAILABLE, { status: 404 })
    }
    // No lender identity: the assistant has nothing true to say, so no message is stored or answered.
    const identity = await findLenderIdentity(tenant.id)
    if (!identity) return NextResponse.json(UNAVAILABLE, { status: 503 })
    const body = await readJsonObject(req)
    if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 })
    const now = new Date()
    const conversationId = verifyChatToken(body.token, now)
    if (!conversationId) {
      // Charged only on failure, per IP, so it throttles token guessing without touching real visitors.
      const bad = checkRateLimit(`website:chat:badtoken:${ip}`, BAD_TOKEN_RATE_LIMIT)
      return bad.allowed ? NextResponse.json(EXPIRED, { status: 401 }) : tooMany(bad.retryAfterSeconds)
    }
    const gate = checkRateLimit(`website:chat:msg:${conversationId}`, MESSAGE_RATE_LIMIT)
    if (!gate.allowed) return tooMany(gate.retryAfterSeconds)
    const text = typeof body.text === "string" ? cleanChatText(body.text) : ""
    if (!text || text.length > MAX_CHAT_MESSAGE_CHARS) return NextResponse.json({ error: `Please keep messages between 1 and ${MAX_CHAT_MESSAGE_CHARS} characters.` }, { status: 400 })

    // `return await` is deliberate: it keeps a rejection inside this try so the catch still runs.
    return await runWithTenant(tenant.id, async () => {
      // Past the cap on messages kept for staff: refused, but the chat goes on (staff can still reply,
      // or in the fallback the visitor has WhatsApp and the call-back), and the visitor is told.
      const limitReached = async () => {
        const { mode } = await current(tenant.id, conversationId)
        return NextResponse.json({ mode, error: mode === "fallback" ? FALLBACK_LIMIT : STAFF_LIMIT }, { status: 429 })
      }
      let chat = await loadChat(tenant.id, conversationId)
      if (!chat) return NextResponse.json(EXPIRED, { status: 401 })
      if (chat.closed) return ended()

      // Staff own the chat from the hand-off until it times out: nothing goes to the model.
      if (chat.mode === "waiting" || chat.mode === "staff") {
        const kept = await recordVisitorMessageToStaff({ tenantId: tenant.id, conversationId, text, now })
        if (kept.accepted) return NextResponse.json({ mode: chat.mode, staffName: chat.staffFirstName })
        if (kept.reason === "closed") return ended()
        if (kept.reason === "staff_cap") return await limitReached()
        // Staff handed the chat back after the read above: the assistant takes the message.
        chat = await loadChat(tenant.id, conversationId)
        if (!chat) return NextResponse.json(EXPIRED, { status: 401 })
        if (chat.closed) return ended()
      }

      const stored = await recordVisitorMessage({ tenantId: tenant.id, conversationId, text, now })
      const bot = { tenantId: tenant.id, conversationId, ip, was: chat.mode }
      if (!stored.accepted) {
        // Closed after the read above: the same answer as a chat that was closed at it.
        if (stored.reason === "closed") return ended()
        // For staff, not the model: they took the chat or a hand-off opened after the read above,
        // or it is in the fallback past the assistant's cap. No reply: the hand-off reply is only
        // ever sent by the call that opens the hand-off.
        if (stored.reason === "to_staff") return stored.stored ? NextResponse.json(await current(tenant.id, conversationId)) : await limitReached()
        // Never sent to the model: a cap hands the chat to staff, and the store kept the message for
        // them. Only the call that opens the hand-off says so; any other (one that lost the race to
        // open it) is told the chat's mode. One the staff-mode cap refused as well is told that.
        const daily = stored.reason === "daily_cap"
        const sent = await sendBotReply({ ...bot, reply: "", needsHuman: true, handoffOnly: true, reason: daily ? "daily_limit" : "message_limit" })
        if (!stored.stored) return await limitReached()
        if (sent.suppressed) return NextResponse.json({ mode: sent.mode, staffName: sent.staffName })
        return NextResponse.json({ reply: sent.reply, handedOff: true, mode: sent.mode }, { status: daily ? 200 : 429 })
      }

      const result: AssistantResult = await askAssistant(
        buildSystemPrompt(await knowledgeFor(tenant.id, identity), identity.tradingName),
        [...chat.turns, { role: "visitor", text }],
      )
      const sent = await sendBotReply({ ...bot, reply: result.reply, needsHuman: result.needsHuman, reason: result.reason })
      // Staff joined, or the chat was handed off, during the model call: its text was not written and is not shown.
      if (sent.suppressed) return NextResponse.json({ mode: sent.mode, staffName: sent.staffName })
      return NextResponse.json({ reply: sent.reply, handedOff: chat.handedOff || result.needsHuman, mode: sent.mode })
    })
  } catch (error) {
    console.error("[website/chat/message] Error:", safeErrorInfo(error))
    return NextResponse.json({ error: "Something went wrong. Please WhatsApp or call us." }, { status: 500 })
  }
}
