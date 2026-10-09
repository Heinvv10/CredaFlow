// Parse an inbound email (IMAP raw source or a Graph `messages` item) into the
// provider-agnostic InboundEmailInput consumed by recordInboundEmailMessage.
// Split out of inbound-poll.ts to keep that file under the 300-line cap and to
// give the parsing/mapping logic its own unit-test surface.

import { simpleParser } from "mailparser"
import type { Provider } from "@prisma/client"

export type InboundEmailInput = {
  // Which transport retrieved this mail (SMTP via IMAP, or MSGRAPH). Carried
  // through to the Message row so provider-scoped dedup + provenance are honest.
  provider: Provider
  providerMessageId: string
  inReplyTo: string | null
  references: string[]
  fromAddress: string
  toAddress: string | null
  subject: string
  bodyText: string | null
  bodyHtml: string | null
  receivedAt: Date
}

/**
 * Best-effort plain-text rendering of an HTML email body, used only when the
 * message carries no text/plain part. The agent inbox renders `bodyText`, so
 * without this an HTML-only reply shows as a blank bubble. This is a display
 * fallback (not sanitisation) — `bodyHtml` is preserved untouched.
 */
export function htmlToPlainText(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n[ \t]*\n[ \t]*\n+/g, "\n\n")
    .trim()
}

/**
 * Parse a raw RFC822 email (IMAP source) into InboundEmailInput.
 * `References` is split on whitespace into individual ids. Returns null when
 * the message lacks a Message-ID (cannot be deduped, so we skip it).
 */
export async function parseInboundEmail(raw: Buffer | string): Promise<InboundEmailInput | null> {
  const mail = await simpleParser(raw)
  const providerMessageId = mail.messageId ?? null
  if (!providerMessageId) return null

  const references = Array.isArray(mail.references)
    ? mail.references
    : mail.references
      ? String(mail.references).split(/\s+/).filter(Boolean)
      : []

  const html = typeof mail.html === "string" ? mail.html : null

  return {
    provider: "SMTP",
    providerMessageId,
    inReplyTo: mail.inReplyTo ?? null,
    references,
    fromAddress: mail.from?.value?.[0]?.address ?? "unknown",
    toAddress: (Array.isArray(mail.to) ? mail.to[0] : mail.to)?.value?.[0]?.address ?? null,
    subject: mail.subject ?? "(no subject)",
    // Prefer the text/plain part; fall back to a stripped-HTML rendering so
    // HTML-only replies aren't stored (and shown) as an empty body.
    bodyText: mail.text ?? (html ? htmlToPlainText(html) : null),
    bodyHtml: html,
    receivedAt: mail.date ?? new Date(),
  }
}

type GraphHeader = { name: string; value: string }
export type GraphMessage = {
  subject?: string
  from?: { emailAddress?: { address?: string } }
  toRecipients?: { emailAddress?: { address?: string } }[]
  receivedDateTime?: string
  body?: { contentType?: string; content?: string }
  internetMessageId?: string
  internetMessageHeaders?: GraphHeader[]
}

/**
 * Map a Graph `messages` API item into InboundEmailInput. Returns null when
 * the message lacks an internetMessageId (cannot be deduped, so we skip it).
 */
export function mapGraphMessage(msg: GraphMessage): InboundEmailInput | null {
  const providerMessageId = msg.internetMessageId ?? null
  if (!providerMessageId) return null

  const header = (name: string) =>
    msg.internetMessageHeaders?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null
  const references = (header("References") ?? "").split(/\s+/).filter(Boolean)
  const isHtml = (msg.body?.contentType ?? "").toLowerCase() === "html"
  const content = msg.body?.content ?? null

  return {
    provider: "MSGRAPH",
    providerMessageId,
    inReplyTo: header("In-Reply-To"),
    references,
    fromAddress: msg.from?.emailAddress?.address ?? "unknown",
    toAddress: msg.toRecipients?.[0]?.emailAddress?.address ?? null,
    subject: msg.subject ?? "(no subject)",
    // HTML bodies get a stripped-text fallback so the agent inbox (which renders
    // bodyText) never shows a blank bubble for an HTML-only reply.
    bodyText: isHtml ? (content ? htmlToPlainText(content) : null) : content,
    bodyHtml: isHtml ? content : null,
    receivedAt: msg.receivedDateTime ? new Date(msg.receivedDateTime) : new Date(),
  }
}
