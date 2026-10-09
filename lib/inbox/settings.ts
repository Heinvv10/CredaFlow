import { prisma } from "@/lib/prisma"
import { Prisma } from "@prisma/client"
import { z } from "zod"
import type { CommsSettings } from "@prisma/client"
import { sealSecret, isSealed } from "@/lib/crypto/secret-box"

// Defined in lib/messaging/wa-provider.ts and re-exported here for the callers
// that already import it from this module — two identically-named unions in one
// repo is a divergence waiting to happen.
export { WA_PROVIDERS, type WaProvider } from "@/lib/messaging/wa-provider"
import { WA_PROVIDERS, type WaProvider } from "@/lib/messaging/wa-provider"

export type CommsSettingsPatch = {
  whatsappEnabled?: boolean
  botsEnabled?: boolean
  chatAlertEmail?: string | null
  waProvider?: string
  wabaId?: string | null
  wabaPhoneNumberId?: string | null
  wabaAccessToken?: string | null
  wabaAppSecret?: string | null
  wabaBusinessId?: string | null
  wabaVerifyToken?: string | null
  autoReplyEnabled?: boolean
  autoReplyText?: string | null
  businessHours?: Prisma.InputJsonValue | null
}

/** Seals a secret WABA field (access token / app secret / verify token) before
 * it hits the DB. FAIL-CLOSED: a non-empty, not-yet-sealed value with no
 * WABA_ENC_KEY configured is a hard error — we refuse to store a plaintext
 * secret rather than silently doing so. Null/empty values and already-sealed
 * values (idempotent) pass through. */
function sealWabaField(value: string | null | undefined): string | null | undefined {
  if (value == null || value === "") return value
  if (isSealed(value)) return value // idempotent
  const key = process.env.WABA_ENC_KEY
  if (!key) throw new Error("WABA_ENC_KEY must be set to store WhatsApp Cloud credentials (refusing to store a secret in plaintext)")
  return sealSecret(value, key)
}

const alertEmailSchema = z.string().trim().email().max(254)
/** The message updateCommsSettings throws for a bad alert address; the settings route answers it per field. */
export const INVALID_CHAT_ALERT_EMAIL = "invalid chatAlertEmail"

/** Blank clears the address (no alert email); anything else must be a valid one. */
function parseAlertEmail(value: string | null): string | null {
  if (value === null) return null
  // The patch arrives as request JSON, so the type is a promise, not a fact.
  if (typeof value !== "string") throw new Error(INVALID_CHAT_ALERT_EMAIL)
  if (value.trim() === "") return null
  const parsed = alertEmailSchema.safeParse(value)
  if (!parsed.success) throw new Error(INVALID_CHAT_ALERT_EMAIL)
  return parsed.data
}

export async function getCommsSettings(tenantId: string): Promise<CommsSettings> {
  return prisma.commsSettings.upsert({
    where: { tenantId },
    create: { tenantId },
    update: {},
  })
}

export async function updateCommsSettings(tenantId: string, patch: CommsSettingsPatch): Promise<CommsSettings> {
  if (patch.waProvider !== undefined && !WA_PROVIDERS.includes(patch.waProvider as WaProvider)) {
    throw new Error(`invalid waProvider: ${patch.waProvider}`)
  }
  const chatAlertEmail = patch.chatAlertEmail === undefined ? undefined : parseAlertEmail(patch.chatAlertEmail)
  await getCommsSettings(tenantId) // ensure the row exists before update

  const data: Prisma.CommsSettingsUpdateInput = {}
  if (patch.whatsappEnabled !== undefined) data.whatsappEnabled = patch.whatsappEnabled
  if (patch.botsEnabled !== undefined) data.botsEnabled = patch.botsEnabled
  if (chatAlertEmail !== undefined) data.chatAlertEmail = chatAlertEmail
  if (patch.waProvider !== undefined) data.waProvider = patch.waProvider
  if (patch.wabaId !== undefined) data.wabaId = patch.wabaId
  if (patch.wabaPhoneNumberId !== undefined) data.wabaPhoneNumberId = patch.wabaPhoneNumberId
  if (patch.wabaAccessToken !== undefined) data.wabaAccessToken = sealWabaField(patch.wabaAccessToken)
  if (patch.wabaAppSecret !== undefined) data.wabaAppSecret = sealWabaField(patch.wabaAppSecret)
  if (patch.wabaBusinessId !== undefined) data.wabaBusinessId = patch.wabaBusinessId
  if (patch.wabaVerifyToken !== undefined) data.wabaVerifyToken = sealWabaField(patch.wabaVerifyToken)
  if (patch.autoReplyEnabled !== undefined) data.autoReplyEnabled = patch.autoReplyEnabled
  if (patch.autoReplyText !== undefined) data.autoReplyText = patch.autoReplyText
  if (patch.businessHours !== undefined) {
    data.businessHours = patch.businessHours === null ? Prisma.JsonNull : patch.businessHours
  }

  return prisma.commsSettings.update({ where: { tenantId }, data })
}
