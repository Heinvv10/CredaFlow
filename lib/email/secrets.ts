// Encryption at rest for the EmailConfig secret columns (smtpPass, imapPass,
// clientSecret). Deliberately mirrors the WhatsApp Cloud path
// (lib/inbox/settings.ts sealWabaField, lib/whatsapp-cloud-config.ts maybeOpen)
// and shares its key env — one box, one key — rather than importing from
// lib/inbox/, which would make the email transport depend on the inbox module.
//
// WRITES FAIL CLOSED: a fresh secret with no key configured is a hard error.
// READS ARE TOLERANT: a legacy plaintext row (no `enc:v1:` marker) passes
// through unchanged, so the deploy is additive.

import { sealSecret, openSecret, isSealed } from "@/lib/crypto/secret-box"

const KEY_ENV = "WABA_ENC_KEY"

/** Seals a secret EmailConfig field before it hits the DB. Null/undefined/empty
 * and already-sealed values pass through (idempotent). A fresh secret with no
 * key configured throws — we refuse to write a mail password in plaintext. */
export function sealField(value: string | null | undefined): string | null | undefined {
  if (value == null || value === "") return value
  if (isSealed(value)) return value // idempotent — placeholder-preserved values arrive sealed
  const key = process.env[KEY_ENV]
  if (!key) {
    throw new Error(
      `${KEY_ENV} must be set to store email credentials (refusing to store a secret in plaintext)`,
    )
  }
  return sealSecret(value, key)
}

/** Reads a stored secret. Sealed values are opened; legacy plaintext passes
 * through. A sealed value with no key is a hard error: handing ciphertext to
 * nodemailer as a password produces an auth failure nobody can diagnose. */
export function openField(value: string): string {
  if (!isSealed(value)) return value // legacy plaintext row — passthrough
  const key = process.env[KEY_ENV]
  if (!key) throw new Error(`${KEY_ENV} is not set but a stored email credential is encrypted`)
  return openSecret(value, key)
}

export function openFieldOrNull(value: string | null): string | null {
  return value == null ? null : openField(value)
}
