import { randomInt } from "node:crypto"

// No I, O, 0 or 1: a visitor may read this reference out over the phone.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"

export function newChatRef(): string {
  let out = "WC-"
  for (let i = 0; i < 6; i++) out += ALPHABET[randomInt(ALPHABET.length)]
  return out
}

const REF_RE = new RegExp(`WC-[${ALPHABET}]{6}`)

/** The chat ref in a thread subject ("Website chat WC-…"), or null: only the ref is ever taken from the subject. */
export function parseChatRef(subject: string | null): string | null {
  return subject?.match(REF_RE)?.[0] ?? null
}
