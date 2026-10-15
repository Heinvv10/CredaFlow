"use client"

import { createContext, useContext, useMemo, type ReactNode } from "react"
import { DEFAULT_LOCALE, type Locale } from "./locales"
import { en } from "./messages/en"
import type { Catalog, Namespace } from "./catalog"
import { interpolate, type MessageKey, type Translator } from "./translate"

type I18nContextValue = { locale: Locale; messages: Partial<Catalog> }

const I18nContext = createContext<I18nContextValue | null>(null)

/**
 * Hands the server-resolved locale and its catalogue slice to client
 * components. Mounted by the portal layout and the website shell.
 */
export function I18nProvider({ locale, messages, children }: I18nContextValue & { children: ReactNode }) {
  const value = useMemo(() => ({ locale, messages }), [locale, messages])
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>
}

export function useLocale(): Locale {
  return useContext(I18nContext)?.locale ?? DEFAULT_LOCALE
}

/**
 * The client-side translator. Without a provider (a component rendered on its
 * own, as unit tests do) it speaks English. Under a non-English provider a
 * namespace the server did not send is a wiring bug and throws, rather than
 * quietly showing English to a reader who chose another language.
 */
export function useT<N extends Namespace>(namespace: N): Translator<N> {
  const ctx = useContext(I18nContext)
  return useMemo(() => {
    const fallback = en[namespace] as Record<string, string>
    let table = fallback
    if (ctx && ctx.locale !== DEFAULT_LOCALE) {
      const sent = ctx.messages[namespace] as Record<string, string> | undefined
      if (!sent) throw new Error(`i18n: namespace "${namespace}" was not sent to the client for locale "${ctx.locale}"`)
      table = sent
    }
    return ((key: MessageKey<N>, vars?: Record<string, string | number>) =>
      interpolate(table[key] ?? fallback[key], vars)) as Translator<N>
  }, [ctx, namespace])
}
