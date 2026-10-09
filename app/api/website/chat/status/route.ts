import { NextRequest, NextResponse } from "next/server"
import { findLenderIdentity } from "@/lib/config/identity"
import { getTenantFromRequest } from "@/lib/tenant"
import { safeErrorInfo } from "@/lib/website-chat/http"
import { chatBotsEnabled } from "@/lib/website-chat/settings"
import { isChatConfigured } from "@/lib/website-chat/token"

const CACHE_HEADERS = { "Cache-Control": "public, max-age=60" }
const reply = (enabled: boolean) => NextResponse.json({ enabled }, { headers: CACHE_HEADERS })

export async function GET(req: NextRequest) {
  try {
    const tenant = await getTenantFromRequest(req)
    if (!tenant || !isChatConfigured()) return reply(false)
    // No identity, nothing true to say: the widget falls back to the contact launcher.
    if (!(await findLenderIdentity(tenant.id))) return reply(false)
    return reply(await chatBotsEnabled(tenant.id))
  } catch (error) {
    console.error("[website/chat/status] Error:", safeErrorInfo(error))
    return reply(false)
  }
}
