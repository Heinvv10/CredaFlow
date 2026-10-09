import { createHmac, timingSafeEqual } from "node:crypto"

export const CHAT_TOKEN_TTL_MS = 2 * 60 * 60 * 1000

function secret(): string {
  const s = process.env.WEBSITE_CHAT_SECRET
  if (!s || s.length < 32) throw new Error("WEBSITE_CHAT_SECRET must be set (32+ chars) to run the website chat")
  return s
}

function sign(payload: string): string {
  return createHmac("sha256", secret()).update(payload).digest("base64url")
}

/**
 * Both secrets present AND a trusted proxy hop count. Without TRUSTED_PROXY, callerIp()
 * returns "unknown" for everyone, so the start route's per-IP limits cannot work
 * (a stranger could exhaust a victim's per-phone bucket). The status route reports
 * disabled otherwise, and start/message 404.
 */
export function isChatConfigured(): boolean {
  const s = process.env.WEBSITE_CHAT_SECRET
  return Boolean(process.env.ANTHROPIC_API_KEY) && Boolean(s && s.length >= 32) && parseInt(process.env.TRUSTED_PROXY ?? "0", 10) > 0
}

/** `<conversationId>.<expiresAtMs>.<hmac>`. cuid ids contain no dots. */
export function issueChatToken(conversationId: string, now: Date): string {
  const payload = `${conversationId}.${now.getTime() + CHAT_TOKEN_TTL_MS}`
  return `${payload}.${sign(payload)}`
}

export function verifyChatToken(token: unknown, now: Date): string | null {
  if (typeof token !== "string") return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  const [conversationId, expires, mac] = parts
  if (!conversationId || !/^\d+$/.test(expires)) return null
  const expected = Buffer.from(sign(`${conversationId}.${expires}`))
  const given = Buffer.from(mac)
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null
  if (Number(expires) < now.getTime()) return null
  return conversationId
}
