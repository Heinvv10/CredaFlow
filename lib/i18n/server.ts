import { cache } from "react"
import { cookies, headers } from "next/headers"
import { prisma } from "@/lib/prisma"
import { getResolvedTenantId, getTenantConfig } from "@/lib/tenant"
import { DEFAULT_LOCALE, LOCALE_COOKIE, isLocale, negotiateLocale, normaliseEnabledLocales, type Locale } from "./locales"
import { CATALOGS, type Catalog, type Namespace } from "./catalog"
import { createTranslator, type Translator } from "./translate"

/**
 * Server-side locale resolution for the website and the portal.
 *
 * No locale in the URL: tenants are routed by host (lib/proxy/tenant-routing.ts),
 * and a /af/… prefix would double every public path, every sitemap entry and
 * every email link for no gain. The language comes from, in order, the
 * switcher cookie, the signed-in client's `preferredLanguage`, and
 * Accept-Language, each only if the tenant has that language enabled.
 */

export async function getTenantEnabledLocales(tenantId: string): Promise<Locale[]> {
  const config = await getTenantConfig(tenantId)
  return normaliseEnabledLocales(config?.enabledLanguages)
}

async function readRequestSignals(): Promise<{ cookie: string | null; acceptLanguage: string | null } | null> {
  try {
    const [cookieStore, headerList] = await Promise.all([cookies(), headers()])
    return {
      cookie: cookieStore.get(LOCALE_COOKIE)?.value ?? null,
      acceptLanguage: headerList.get("accept-language"),
    }
  } catch {
    // No request scope (build-time render, unit test): no signals, so English,
    // the same fallback a request without any signal gets.
    return null
  }
}

/**
 * The request's session, loaded on first use. Every website and portal
 * component imports this module; importing next-auth with it would make each
 * of their unit tests load (or mock) the auth stack, while only a real request
 * ever reaches this line.
 */
export async function loadSession() {
  const { getSession } = await import("@/lib/auth-session")
  return getSession()
}

export const getLocale = cache(async (): Promise<Locale> => {
  const signals = await readRequestSignals()
  if (!signals) return DEFAULT_LOCALE

  const session = await loadSession()
  const client = session?.user?.role === "CLIENT" && session.user.tenantId && session.user.id
    ? { id: session.user.id, tenantId: session.user.tenantId }
    : null
  const tenantId = client ? client.tenantId : await getResolvedTenantId()
  const enabled = await getTenantEnabledLocales(tenantId)
  if (enabled.length === 1) return enabled[0]

  // The profile is read only when the cookie does not already decide.
  const cookieDecides = isLocale(signals.cookie) && enabled.includes(signals.cookie)
  const profile = client && !cookieDecides
    ? (await prisma.client.findFirst({
        where: { id: client.id, tenantId: client.tenantId },
        select: { preferredLanguage: true },
      }))?.preferredLanguage ?? null
    : null

  return negotiateLocale({ enabled, cookie: signals.cookie, profile, acceptLanguage: signals.acceptLanguage })
})

export async function getT<N extends Namespace>(namespace: N): Promise<Translator<N>> {
  return createTranslator(await getLocale(), namespace)
}

/**
 * The catalogue slice a client-component subtree needs, for I18nProvider.
 * English sends nothing: client components fall back to the bundled English
 * catalogue, which is what their literals were before extraction.
 */
export function clientMessages(locale: Locale, namespaces: readonly Namespace[]): Partial<Catalog> {
  if (locale === DEFAULT_LOCALE) return {}
  return Object.fromEntries(namespaces.map((ns) => [ns, CATALOGS[locale][ns]])) as Partial<Catalog>
}
