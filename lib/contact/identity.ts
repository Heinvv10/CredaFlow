// Identity normalisation for Phase 9 Contact + ContactIdentity writes.
//
// Spec §Inbound matcher pipeline: "Normalise the identifier. Email →
// lowercase + trim. Phone → E.164 (default region ZA). WA → JID. Twilio
// caller ID → E.164." Spec §WABA mapping table: "Normalise to E.164 digits
// without '+'."
//
// Canonical location for these helpers — the S2 backfill, S3 inbound matcher,
// and S2 outbound send.ts all read through here so the (tenantId, channel,
// value) ContactIdentity unique-index lookups stay consistent across writers.

/**
 * Email: trim then lowercase. Empty string returns "" — callers should
 * `if (norm.length === 0) return null` before insert.
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase()
}

/**
 * SA phone → E.164 digits without "+", per spec §WABA mapping.
 *   "0821234567"     → "27821234567"
 *   "+27821234567"   → "27821234567"
 *   "0027821234567"  → "27821234567"
 *   " 082 123 4567 " → "27821234567"
 *
 * Strict by design. Returns "" for any input that doesn't match a
 * recognised SA pattern (foreign numbers, alphanumeric junk, partial
 * digits). Loose normalisation here corrupts the (tenantId, channel, value)
 * ContactIdentity index — a 10-digit foreign number with no leading "0"
 * would be silently coerced to look SA. Caller MUST treat "" as "skip
 * this identity row" (it does not represent a writable value).
 *
 * SA dialing plan: leading 0 + nine digits where the second digit is
 * 1-8 (covers mobile 06/07/08 and geographic 01–05). 09 is not yet
 * assigned at the time of writing but reserved by ICASA, so we accept it.
 */
export function normalisePhone(phone: string): string {
  // Reject anything with non-phone characters before stripping (so "abc123"
  // can't sneak past as "123").
  if (!/^[\s\-+()\d]+$/.test(phone)) return ""

  const stripped = phone.replace(/[\s\-+()]/g, "")
  if (stripped.length === 0) return ""
  if (!/^\d+$/.test(stripped)) return ""

  // SA local 0-prefixed: must be exactly 10 digits, leading "0" + 0-9.
  if (/^0\d{9}$/.test(stripped)) {
    return "27" + stripped.slice(1)
  }
  // International SA with country code 27: 11 digits starting "27".
  if (/^27\d{9}$/.test(stripped)) {
    return stripped
  }
  // "0027..." style (some inbound systems use this for international SA).
  if (/^002\d{10}$/.test(stripped)) {
    return stripped.slice(2)
  }
  // Anything else → reject. Better an empty identity row than a colliding
  // misclassification.
  return ""
}

/**
 * WhatsApp JID = E.164 digits + "@s.whatsapp.net" (per `lib/whatsapp.ts`
 * convention and the Contact.primaryWaJid model comment). Inherits the
 * strict validation in `normalisePhone` — returns "" for unparseable input
 * (e.g. "WhatsApp: 082..." leaves alpha residue after strip → rejected).
 */
export function toWaJid(phone: string): string {
  const digits = normalisePhone(phone)
  if (digits.length === 0) return ""
  return `${digits}@s.whatsapp.net`
}

import type { Channel, Contact } from "@prisma/client"

type ContactIdentityPrismaLike = {
  contactIdentity: {
    findFirst: (args: {
      where: { tenantId: string; channel: Channel; value: string }
      include: { contact: true }
    }) => Promise<{ contact: Contact } | null>
  }
}

/**
 * Find a Contact by an exact (tenantId, channel, value) ContactIdentity match.
 *
 * The value MUST be normalised before calling — emails via `normaliseEmail`,
 * phones via `normalisePhone`, WhatsApp JIDs via `toWaJid`. The ContactIdentity
 * (tenantId, channel, value) index is strict-equality; mismatched casing or
 * leading "+" will silently miss.
 *
 * Returns null on miss so callers can decide their unknown-sender policy
 * (the WA STOP webhook returns 200 OK; the inbound-matcher does create-on-miss).
 */
export async function lookupContactByChannelValue(
  prisma: ContactIdentityPrismaLike,
  opts: { tenantId: string; channel: Channel; value: string }
): Promise<Contact | null> {
  const row = await prisma.contactIdentity.findFirst({
    where: {
      tenantId: opts.tenantId,
      channel: opts.channel,
      value: opts.value,
    },
    include: { contact: true },
  })
  return row?.contact ?? null
}
