import { prisma } from "@/lib/prisma"
import { openSecret, isSealed } from "@/lib/crypto/secret-box"

export type WabaCreds = {
  phoneNumberId: string
  accessToken: string
}

/** A sealed value carries the `enc:v1:` marker. Plaintext legacy rows lack the
 * marker, so they pass through unchanged — this makes the migration
 * non-breaking. A sealed value with no key configured is a hard error: we
 * cannot silently hand back ciphertext as if it were a usable credential. */
function maybeOpen(value: string): string {
  if (!isSealed(value)) return value // legacy plaintext row — passthrough
  const key = process.env.WABA_ENC_KEY
  if (!key) throw new Error("WABA_ENC_KEY is not set but a stored WhatsApp credential is encrypted")
  return openSecret(value, key)
}

export class WabaNotConfiguredError extends Error {
  constructor(tenantId: string) {
    super(`WhatsApp Cloud credentials are not configured for tenant ${tenantId}`)
    this.name = "WabaNotConfiguredError"
  }
}

type WabaCredColumns = {
  wabaPhoneNumberId: string | null
  wabaAccessToken: string | null
}

/**
 * Pure resolver — DB-free so it is trivially testable. Throws if either
 * required send credential is missing or blank.
 */
export function resolveWabaCreds(
  settings: WabaCredColumns | null,
  tenantId: string,
): WabaCreds {
  const phoneNumberId = settings?.wabaPhoneNumberId?.trim()
  const rawToken = settings?.wabaAccessToken?.trim()
  if (!phoneNumberId || !rawToken) throw new WabaNotConfiguredError(tenantId)
  return { phoneNumberId, accessToken: maybeOpen(rawToken) }
}

/**
 * The ONLY place WABA send credentials are read. If these columns become
 * encrypted-at-rest, decrypt here and no call site changes.
 */
export async function getWabaCreds(tenantId: string): Promise<WabaCreds> {
  const settings = await prisma.commsSettings.findUnique({
    where: { tenantId },
    select: { wabaPhoneNumberId: true, wabaAccessToken: true },
  })
  return resolveWabaCreds(settings, tenantId)
}

export type { WabaTemplateCreds } from "./whatsapp/graph-templates"
import type { WabaTemplateCreds } from "./whatsapp/graph-templates"

/**
 * The ONLY place WABA template-management credentials are read. Decrypts
 * the access token when it looks sealed (see `maybeOpen`).
 */
export async function getWabaTemplateCreds(tenantId: string): Promise<WabaTemplateCreds> {
  const settings = await prisma.commsSettings.findUnique({
    where: { tenantId },
    select: { wabaId: true, wabaAccessToken: true },
  })
  const wabaId = settings?.wabaId?.trim()
  const rawToken = settings?.wabaAccessToken?.trim()
  if (!wabaId || !rawToken) throw new WabaNotConfiguredError(tenantId)
  return { wabaId, accessToken: maybeOpen(rawToken) }
}
