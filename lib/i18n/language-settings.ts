import { Prisma } from "@prisma/client"
import type { prisma as PrismaClientInstance } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { normaliseEnabledLocales, type Locale } from "./locales"
import { parseLanguageReviews, parseLanguageUpdate, withAcknowledgements, type LanguageReviews } from "./language-reviews"

type Tx = Pick<typeof PrismaClientInstance, "$executeRaw" | "tenantConfig" | "auditLog">

export type LanguageSettingsResult =
  | { ok: true; changed: boolean; enabled: Locale[]; reviews: LanguageReviews }
  | { ok: false; error: string }

/**
 * The one write path for a tenant's borrower languages (admin API and the
 * SUPER_ADMIN settings page). Run inside the caller's transaction: the config
 * write and its TENANT_LANGUAGES_UPDATED audit row commit together, and a
 * non-English language without a native-speaker review acknowledgement
 * (stored, or given in this request) refuses the whole write.
 */
export async function applyTenantLanguages(
  tx: Tx,
  args: {
    tenantId: string
    actor: { id: string | null; email: string | null }
    input: { enabledLanguages: unknown; acknowledgements: unknown }
    ipAddress?: string
    now?: Date
  },
): Promise<LanguageSettingsResult> {
  // Serialise this tenant's language writers, so two acknowledgements cannot
  // both read the old reviews and one overwrite the other's record.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tenant-languages:${args.tenantId}`}))`
  const before = await tx.tenantConfig.findUnique({
    where: { tenantId: args.tenantId },
    select: { enabledLanguages: true, languageReviews: true },
  })
  const storedReviews = parseLanguageReviews(before?.languageReviews)
  const parsed = parseLanguageUpdate(args.input, storedReviews)
  if (!parsed.ok) return parsed

  const { enabled, acknowledgements } = parsed.update
  const reviews = withAcknowledgements(storedReviews, acknowledgements, args.actor, args.now ?? new Date())
  const previous = normaliseEnabledLocales(before?.enabledLanguages)
  const changed = previous.join(",") !== enabled.join(",") || Object.keys(acknowledgements).length > 0
  if (!changed) return { ok: true, changed: false, enabled, reviews }

  const data = { enabledLanguages: enabled, languageReviews: reviews as Prisma.InputJsonValue }
  await tx.tenantConfig.upsert({
    where: { tenantId: args.tenantId },
    create: { tenantId: args.tenantId, ...data },
    update: data,
  })
  await logAuditStrict({
    tenantId: args.tenantId,
    userId: args.actor.id ?? undefined,
    userEmail: args.actor.email ?? undefined,
    action: AuditAction.TENANT_LANGUAGES_UPDATED,
    entity: "TenantConfig",
    entityId: args.tenantId,
    oldValue: { enabledLanguages: previous },
    newValue: { enabledLanguages: enabled, reviewAcknowledgements: acknowledgements },
    ipAddress: args.ipAddress,
  }, tx)
  return { ok: true, changed: true, enabled, reviews }
}
