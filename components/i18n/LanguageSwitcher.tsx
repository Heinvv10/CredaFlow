"use client"

import { useId, useState, useTransition } from "react"
import { useRouter } from "next/navigation"
import { Languages } from "lucide-react"
import { setLocaleAction } from "@/app/actions/locale"
import { useLocale, useT } from "@/lib/i18n/client"
import { LOCALE_NATIVE_NAMES, isLocale, type Locale } from "@/lib/i18n/locales"
import { cn } from "@/lib/utils"

type LanguageSwitcherProps = {
  /** The tenant's enabled languages (server-resolved). Fewer than two renders nothing. */
  enabled: readonly Locale[]
  className?: string
}

/**
 * Language picker for the website and portal headers. Each option is written
 * in its own language. The choice is stored server-side (cookie, and the
 * client's profile when signed in) and the page re-renders from the server.
 */
export function LanguageSwitcher({ enabled, className }: LanguageSwitcherProps) {
  if (enabled.length < 2) return null
  return <LanguageSelect enabled={enabled} className={className} />
}

function LanguageSelect({ enabled, className }: LanguageSwitcherProps) {
  const locale = useLocale()
  const t = useT("common")
  const router = useRouter()
  const id = useId()
  const [pending, startTransition] = useTransition()
  const [failed, setFailed] = useState(false)

  function choose(value: string) {
    if (!isLocale(value) || value === locale) return
    startTransition(async () => {
      const result = await setLocaleAction(value)
      setFailed(!result.ok)
      if (result.ok) router.refresh()
    })
  }

  return (
    <div className={cn("inline-flex items-center gap-1.5", className)}>
      <Languages className="h-4 w-4 shrink-0 opacity-70" aria-hidden="true" />
      <label htmlFor={id} className="sr-only">{t("language")}</label>
      <select
        id={id}
        value={locale}
        disabled={pending}
        onChange={(e) => choose(e.target.value)}
        className="h-9 rounded-md border border-current/20 bg-transparent px-2 text-xs font-medium text-current focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--cf-brand)] disabled:opacity-60"
      >
        {enabled.map((code) => (
          <option key={code} value={code} lang={code} className="bg-[var(--cf-bg-panel)] text-[var(--cf-text)]">
            {LOCALE_NATIVE_NAMES[code]}
          </option>
        ))}
      </select>
      {failed && <span role="alert" className="text-xs text-[var(--cf-danger)]">{t("languageChangeFailed")}</span>}
    </div>
  )
}
