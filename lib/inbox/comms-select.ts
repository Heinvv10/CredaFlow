import type { Prisma } from "@prisma/client"

/** CommsSettings columns updateCommsSettings seals with sealWabaField. Reading
 * one into a page or API response would hand out ciphertext at best and a live
 * credential at worst. */
type SealedCommsColumn = "wabaAccessToken" | "wabaAppSecret" | "wabaVerifyToken"

/**
 * A CommsSettings select shape that cannot name a sealed column.
 *
 * Scope of the guarantee: this constrains only the declaration it annotates
 * (via `satisfies` below) — editing PUBLIC_COMMS_SETTINGS_SELECT to add a
 * sealed column is a compile error. It does NOT police other call sites,
 * because Prisma types `findUnique`'s `select` against its own generated
 * CommsSettingsSelect; a fresh literal, a cast, or
 * `select: { ...PUBLIC_COMMS_SETTINGS_SELECT, wabaAccessToken: true }`
 * elsewhere still type-checks. Reading credentials stays the job of
 * lib/whatsapp-cloud-config.ts, which is the only sanctioned reader.
 */
export type PublicCommsSettingsSelect =
  Omit<Prisma.CommsSettingsSelect, SealedCommsColumn> & { [K in SealedCommsColumn]?: never }

/** What the WhatsApp settings page renders: provider + the public phone-number
 * identifier. Never a credential. */
export const PUBLIC_COMMS_SETTINGS_SELECT = {
  waProvider: true,
  wabaPhoneNumberId: true,
} as const satisfies PublicCommsSettingsSelect
