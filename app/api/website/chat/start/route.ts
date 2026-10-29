import { NextRequest, NextResponse } from "next/server"
import { logAudit } from "@/lib/audit"
import { findLenderIdentity } from "@/lib/config/identity"
import { callerIp, checkRateLimit } from "@/lib/rate-limit"
import { getTenantFromRequest } from "@/lib/tenant"
import { runWithTenant } from "@/lib/tenant-scope"
import { verifyTurnstile } from "@/lib/turnstile"
import { startChat } from "@/lib/website-chat/store"
import { isChatConfigured, issueChatToken } from "@/lib/website-chat/token"
import { readJsonObject, safeErrorInfo } from "@/lib/website-chat/http"
import { chatBotsEnabled } from "@/lib/website-chat/settings"
import { validateChatStart } from "@/lib/website-chat/validate"

const PHONE_LIMIT = { limit: 3, windowMs: 15 * 60 * 1000 } as const
const IP_LIMIT = { limit: 10, windowMs: 15 * 60 * 1000 } as const
// A backstop on DB rows only: model spend is bounded by DAILY_BOT_REPLY_CAP.
const SITE_LIMIT = { limit: 200, windowMs: 15 * 60 * 1000 } as const
const UNAVAILABLE = { error: "The chat is not available right now. Please WhatsApp or call us." }

function tooMany(retryAfterSeconds: number) {
  return NextResponse.json({ error: "Too many chats started. Please try again later." }, { status: 429, headers: { "Retry-After": String(retryAfterSeconds) } })
}

export async function POST(req: NextRequest) {
  try {
    const ip = callerIp(req)
    const tenant = await getTenantFromRequest(req)
    if (!tenant || !isChatConfigured() || !(await chatBotsEnabled(tenant.id))) {
      return NextResponse.json(UNAVAILABLE, { status: 404 })
    }
    // No lender identity: the greeting and consent would name nobody, so no chat is started.
    const identity = await findLenderIdentity(tenant.id)
    if (!identity) return NextResponse.json(UNAVAILABLE, { status: 503 })
    const body = await readJsonObject(req)
    if (!body) return NextResponse.json({ error: "Invalid request." }, { status: 400 })
    const turnstile = await verifyTurnstile(typeof body.turnstileToken === "string" ? body.turnstileToken : null, ip)
    if (!turnstile.ok) return NextResponse.json({ error: "Verification failed. Please refresh the page and try again." }, { status: 400 })

    const v = validateChatStart(body)
    if (!v.ok) return NextResponse.json({ error: "Please check the highlighted fields.", errors: v.errors }, { status: 400 })

    // Limits are charged only after Turnstile and validation pass, so junk POSTs cannot burn a bucket.
    // The address bucket goes first and a refusal stops there: the phone bucket is keyed by a number the caller
    // chooses, so an address already blocked must not write a fresh row per made-up number.
    // Without a real IP every caller would share one bucket, turning a per-IP limit into a site-wide one.
    if (ip !== "unknown") {
      const perIp = await checkRateLimit(`website:chat:start:ip:${ip}`, IP_LIMIT)
      if (!perIp.allowed) return tooMany(perIp.retryAfterSeconds)
    }
    const perPhone = await checkRateLimit(`website:chat:start:phone:${v.fields.phone}:${ip}`, PHONE_LIMIT)
    if (!perPhone.allowed) return tooMany(perPhone.retryAfterSeconds)
    const siteWide = await checkRateLimit("website:chat:start:all", SITE_LIMIT)
    if (!siteWide.allowed) return tooMany(siteWide.retryAfterSeconds)

    const now = new Date()
    const started = await runWithTenant(tenant.id, () => startChat({ tenantId: tenant.id, fields: v.fields, now, brand: identity.tradingName }))
    await logAudit({
      tenantId: tenant.id, action: "WEBSITE_CHAT_STARTED", entity: "Conversation", entityId: started.conversationId, ipAddress: ip,
      newValue: { leadId: started.leadId, contactId: started.contactId, matchedExisting: started.matchedContactIds.length },
    })
    return NextResponse.json({ token: issueChatToken(started.conversationId, now), greeting: started.greeting, ref: started.ref })
  } catch (error) {
    console.error("[website/chat/start] Error:", safeErrorInfo(error))
    return NextResponse.json({ error: "Something went wrong. Please WhatsApp or call us." }, { status: 500 })
  }
}
