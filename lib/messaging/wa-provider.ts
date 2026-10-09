import type { Provider } from "@prisma/client"

/**
 * The transports that can deliver a WhatsApp message — the ONE definition.
 *
 * It lives here rather than in `lib/inbox/settings.ts` (which re-exports it for
 * its existing callers) because that module imports `@/lib/prisma`, and the
 * inbound persist paths that need this type are deliberately pure and
 * tx-injected. This file has no runtime dependency at all.
 *
 * `satisfies readonly Provider[]` ties the list to Prisma's enum: a typo, or a
 * member removed from the schema, fails the build. The array form is kept
 * because `lib/inbox/settings.ts` validates user input against it at runtime.
 *
 * Narrower than `Provider` on purpose: the inbound persist paths hardcode
 * `channel: "WHATSAPP"`, so the wide enum would type-legally permit labelling a
 * WhatsApp message `RESEND` or `TWILIO_VOICE`.
 *
 * Callers must pass one explicitly — **no parameter default anywhere**. The
 * defect this exists for was a WhatsApp Cloud inbound message hardcoded as
 * `WA_UNOFFICIAL` on two of three persist paths, and a default reproduces it
 * exactly: silently wrong for any caller that forgets. Required means
 * `tsc --noEmit` enumerates the call sites instead of a test hoping to.
 */
export const WA_PROVIDERS = ["WA_UNOFFICIAL", "WA_CLOUD", "WA_BSP_360DIALOG"] as const satisfies readonly Provider[]

export type WaProvider = (typeof WA_PROVIDERS)[number]
