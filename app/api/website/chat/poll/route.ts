import { NextRequest, NextResponse } from "next/server"
import { callerIp, checkRateLimit } from "@/lib/rate-limit"
import { getTenantFromRequest } from "@/lib/tenant"
import { runWithTenant } from "@/lib/tenant-scope"
import { expireHandoffIfDue } from "@/lib/website-chat/handoff"
import { readJsonObject, safeErrorInfo } from "@/lib/website-chat/http"
import { chatBotsEnabled } from "@/lib/website-chat/settings"
import { loadChat } from "@/lib/website-chat/store"
import { isChatConfigured, verifyChatToken } from "@/lib/website-chat/token"

const POLL_RATE_LIMIT = { limit: 40, windowMs: 60_000 } as const
const BAD_TOKEN_RATE_LIMIT = { limit: 30, windowMs: 10 * 60 * 1000 } as const
const EXPIRED = { error: "This chat session has expired. Please start a new chat." }

function tooMany(retryAfterSeconds: number) {
  return NextResponse.json({ error: "Please wait a moment." }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } })
}

/** Read-only for the visitor's widget: the only write is the timeout expiry, done by the store. */
export async function POST(req: NextRequest) {
  try {
    const ip = callerIp(req)
    const tenant = await getTenantFromRequest(req)
    if (!tenant || !isChatConfigured() || !(await chatBotsEnabled(tenant.id))) {
      return NextResponse.json({ error: "The chat is not available right now. Please WhatsApp or call us." }, { status: 404 })
    }
    const body = await readJsonObject(req)
    if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 })
    const now = new Date()
    const conversationId = verifyChatToken(body.token, now)
    if (!conversationId) {
      const bad = await checkRateLimit(`website:chat:badtoken:${ip}`, BAD_TOKEN_RATE_LIMIT)
      return bad.allowed ? NextResponse.json(EXPIRED, { status: 401 }) : tooMany(bad.retryAfterSeconds)
    }
    const gate = await checkRateLimit(`website:chat:poll:${conversationId}`, POLL_RATE_LIMIT)
    if (!gate.allowed) return tooMany(gate.retryAfterSeconds)

    // `return await` is deliberate: it keeps a rejection inside this try so the catch still runs.
    return await runWithTenant(tenant.id, async () => {
      let chat = await loadChat(tenant.id, conversationId)
      if (!chat) return NextResponse.json(EXPIRED, { status: 401 })
      if (chat.mode === "waiting") {
        if (await expireHandoffIfDue({ tenantId: tenant.id, conversationId, now })) {
          return NextResponse.json({ mode: "fallback", staffName: null, ref: chat.ref, lines: chat.lines })
        }
        // Not due, or lost the race: a staffer may have joined or another caller expired it.
        chat = await loadChat(tenant.id, conversationId)
        if (!chat) return NextResponse.json(EXPIRED, { status: 401 })
      }
      return NextResponse.json({ mode: chat.mode, staffName: chat.staffFirstName, ref: chat.ref, lines: chat.lines })
    })
  } catch (error) {
    console.error("[website/chat/poll] Error:", safeErrorInfo(error))
    return NextResponse.json({ error: "Something went wrong. Please WhatsApp or call us." }, { status: 500 })
  }
}
