import { prisma } from "@/lib/prisma"
import type { WA_TEMPLATES } from "@/lib/whatsapp"
import { DEFAULT_LOCALE, isLocale, normaliseEnabledLocales, type Locale } from "./locales"
import { createTranslator } from "./translate"

/**
 * The WhatsApp free-text bodies that go out in the client's language. Not
 * here, so always English: application_declined, section129 and the
 * collections reminders.
 */
export type LocalizedWaTemplates = Pick<
  typeof WA_TEMPLATES,
  "application_submitted" | "application_approved" | "loan_disbursed" | "payment_received" | "payment_overdue_1d" | "payment_overdue_7d"
>

/** WA_TEMPLATES' signatures, worded from the comms catalogue. English callers keep WA_TEMPLATES itself. */
export function localizedWaTemplates(locale: Locale): LocalizedWaTemplates {
  const t = createTranslator(locale, "comms")
  return {
    application_submitted: (name, ref, amount, brand) => t("wa_application_submitted", { name, ref, amount, brand }),
    application_approved: (name, amount, ref) => t("wa_application_approved", { name, amount, ref }),
    loan_disbursed: (name, amount, dueDate) => t("wa_loan_disbursed", { name, amount, dueDate }),
    payment_received: (name, amount, balance) => t("wa_payment_received", { name, amount, balance }),
    payment_overdue_1d: (name, amount, ref) => t("wa_payment_overdue_1d", { name, amount, ref }),
    payment_overdue_7d: (name, amount, ref, phone) => t("wa_payment_overdue_7d", { name, amount, ref, phone }),
  }
}

/**
 * The language a borrower message goes out in: the client's
 * `preferredLanguage` when the tenant has that language enabled, else English.
 * A message is never sent in a language the lender has not switched on.
 */
export function resolveCommsLocale(preferred: string | null | undefined, enabled: readonly Locale[]): Locale {
  return isLocale(preferred) && enabled.includes(preferred) ? preferred : DEFAULT_LOCALE
}

/**
 * resolveCommsLocale for a client of `tenantId`. Reads the tenant's enabled
 * languages only when the preference is not already English, so an English
 * client costs no query.
 */
export async function clientCommsLocale(tenantId: string, preferred: string | null | undefined): Promise<Locale> {
  if (!isLocale(preferred) || preferred === DEFAULT_LOCALE) return DEFAULT_LOCALE
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { enabledLanguages: true },
  })
  return resolveCommsLocale(preferred, normaliseEnabledLocales(config?.enabledLanguages))
}

/**
 * WhatsApp template language variants.
 *
 * A Meta template is approved per (name, language), and `MessageTemplate`
 * keeps one row per key, carrying that row's `language`. A translated variant
 * of `<key>` is the row keyed `<key>__<locale>` whose `language` is that
 * locale (its `event` likewise `<event>__<locale>`, for the legacy
 * (tenant, event, channel) unique). A variant is used only when it exists, is
 * active and its `language` agrees; otherwise the base row (English) is sent.
 * No variant rows are seeded: each needs its own Meta approval first.
 */
export function templateVariantKey(baseKey: string, locale: Locale): string {
  return `${baseKey}__${locale}`
}

export function pickTemplateForLocale<T extends { language: string; active: boolean }>(
  byKey: Readonly<Record<string, T | undefined>>,
  baseKey: string,
  locale: Locale,
): T | undefined {
  if (locale !== DEFAULT_LOCALE) {
    const variant = byKey[templateVariantKey(baseKey, locale)]
    if (variant && variant.active && variant.language === locale) return variant
  }
  return byKey[baseKey]
}
