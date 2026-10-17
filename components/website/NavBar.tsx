"use client"

import { useState, useRef, useEffect, useSyncExternalStore } from "react"
import Link from "next/link"
import { Menu, X, ChevronDown } from "lucide-react"
import { APPLY_DRAFT_KEY, QUALIFY_DRAFT_KEY } from "@/lib/draft-keys"
import { useWebsiteIdentity } from "@/components/website/WebsiteIdentity"
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher"
import { useT } from "@/lib/i18n/client"
import type { Locale } from "@/lib/i18n/locales"
import type { MessageKey } from "@/lib/i18n/translate"

type NavLink = { label: MessageKey<"websiteShell">; href: string; children?: { label: string; href: string; description: string }[] }

// The kept public pages only: offer → evaluate → contact.
const navLinks: NavLink[] = [
  { label: "navHome", href: "/" },
  { label: "navInsurance", href: "/site/products/insurance" },
  { label: "navCalculators", href: "/site/calculators" },
  { label: "navContact", href: "/site/contact" },
]

function browserHasApplicationDraft() {
  try {
    return (
      Boolean(window.localStorage.getItem(APPLY_DRAFT_KEY)) ||
      Boolean(window.localStorage.getItem(QUALIFY_DRAFT_KEY))
    )
  } catch {
    return false
  }
}

// The apply and qualify pages fire lms:draft-updated when they save; storage
// covers other tabs.
function subscribeToDrafts(onChange: () => void) {
  window.addEventListener("storage", onChange)
  window.addEventListener("lms:draft-updated", onChange)
  return () => {
    window.removeEventListener("storage", onChange)
    window.removeEventListener("lms:draft-updated", onChange)
  }
}

export default function NavBar({ enabledLocales = [], logoSrc = null }: {
  enabledLocales?: readonly Locale[]
  /** The lender's logo (lib/config/lender-logo.ts publicLenderLogoSrc); null shows the name alone. */
  logoSrc?: string | null
}) {
  const identity = useWebsiteIdentity()
  // Insurance is a FAIS intermediary's offer: no FSP number, no link to it.
  const links = navLinks.filter((link) => link.label !== "navInsurance" || identity.fspNumber)
  const t = useT("websiteShell")
  const [open, setOpen] = useState(false)
  const [dropdown, setDropdown] = useState<string | null>(null)
  // localStorage is an external store: the server (and the hydration render)
  // see no draft, so the Login href matches the server HTML, then the browser's
  // answer lands. Reading it in a useState initializer mismatched on hydration.
  const hasDraft = useSyncExternalStore(subscribeToDrafts, browserHasApplicationDraft, () => false)
  const dropdownRef = useRef<HTMLDivElement>(null)
  // Marketing "Login" is always for clients — staff use the workspace URL
  // directly, not surfaced from marketing.
  //
  // In production marketing is served from the staff container (APP_MODE=staff)
  // which 404s portal routes, so the login URL must be absolute and cross-host
  // to the client container: NEXT_PUBLIC_PORTAL_LOGIN_URL, else
  // NEXT_PUBLIC_PORTAL_URL + /portal/login. With neither set (dev, APP_MODE=all)
  // it stays on this host. There is no default host: a deployment's own env
  // names its portal.
  // `|| undefined` treats an empty string the same as unset — the Docker
  // build declares these ARGs with an empty default, so an unset override
  // still reaches here as an ENV-defined "" rather than a truly absent var.
  const portalUrl = (process.env.NEXT_PUBLIC_PORTAL_URL || undefined)?.replace(/\/+$/, "")
  const portalLoginBase =
    (process.env.NEXT_PUBLIC_PORTAL_LOGIN_URL || undefined) ??
    `${portalUrl ?? ""}/portal/login`
  const loginHref = hasDraft
    ? `${portalLoginBase}?callbackUrl=${encodeURIComponent("/portal")}`
    : portalLoginBase

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdown(null)
      }
    }
    document.addEventListener("mousedown", handleClick)
    return () => document.removeEventListener("mousedown", handleClick)
  }, [])

  return (
    <header className="sticky top-[var(--cf-demo-banner-h)] z-50 border-b border-white/10 bg-[#1b1d24]/95 shadow-[0_16px_50px_rgba(0,0,0,0.28)] backdrop-blur-md">
      <div className="max-w-[88rem] mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          <Link href="/" className="flex items-center gap-2 min-[1440px]:gap-2.5 flex-shrink-0">
            {logoSrc ? (
              // eslint-disable-next-line @next/next/no-img-element -- a per-tenant API response, not a static asset
              <img src={logoSrc} alt={identity.tradingName} className="h-9 w-auto max-w-[200px] rounded bg-white object-contain px-1.5 py-0.5" />
            ) : (
              <span className="text-white font-bold text-lg tracking-tight">{identity.tradingName}</span>
            )}
          </Link>

          <nav aria-label={t("mainNavLabel")} className="hidden xl:flex items-center gap-0.5" ref={dropdownRef}>
            {links.map((link) =>
              link.children ? (
                <div key={link.href} className="relative">
                  <button
                    onClick={() => setDropdown(dropdown === link.label ? null : link.label)}
                    className="flex items-center gap-1 whitespace-nowrap px-2.5 py-2 text-sm font-medium text-white/72 transition-colors hover:text-white"
                  >
                    {t(link.label)}
                    <ChevronDown size={14} className={`transition-transform ${dropdown === link.label ? "rotate-180" : ""}`} />
                  </button>
                  {dropdown === link.label && (
                    // Anchored flush to the trigger (mt-1, not mt-3) so the panel
                    // doesn't read as detached. This dropdown opens on click, not
                    // hover, so there's no hover-path gap to bridge.
                    <div className="absolute left-0 top-full mt-1 w-64 border border-white/12 bg-[#11141b]/95 py-2 shadow-[0_24px_80px_rgba(0,0,0,0.42)] backdrop-blur-md">
                      {link.children.map((child) => (
                        <Link
                          key={child.href}
                          href={child.href}
                          onClick={() => setDropdown(null)}
                          className="block px-4 py-2.5 transition-colors hover:bg-white/[0.06]"
                        >
                          <span className="block text-sm font-semibold text-white/86">{child.label}</span>
                          <span className="mt-0.5 block text-xs leading-4 text-white/50">{child.description}</span>
                        </Link>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <Link
                  key={link.href}
                  href={link.href}
                  className="whitespace-nowrap px-2.5 py-2 text-sm font-medium text-white/72 transition-colors hover:text-white"
                >
                  {t(link.label)}
                </Link>
              )
            )}
          </nav>

          <div className="hidden xl:flex items-center gap-2">
            <LanguageSwitcher enabled={enabledLocales} className="text-white/72" />
            <Link href="/site/qualify" className="whitespace-nowrap border border-[#a5b4fc]/70 px-3 py-2 text-sm font-semibold text-[#a5b4fc] transition-colors hover:bg-[#a5b4fc]/10">
              {t("checkQualify")}
            </Link>
            <Link href={loginHref} className="whitespace-nowrap text-sm font-medium text-white/72 transition-colors hover:text-white">
              {t("login")}
            </Link>
            <Link href="/site/apply" className="whitespace-nowrap bg-[#a5b4fc] px-3 py-2 text-sm font-semibold text-[#11141b] transition-colors hover:bg-[#c7d2fe]">
              {t("applyNow")}
            </Link>
          </div>

          <div className="flex items-center gap-1 xl:hidden">
            <LanguageSwitcher enabled={enabledLocales} className="text-white/72" />
            <button className="p-2 text-white/72 hover:text-white" onClick={() => setOpen(!open)} aria-label={t("toggleMenu")}>
              {open ? <X size={24} /> : <Menu size={24} />}
            </button>
          </div>
        </div>
      </div>

      {open && (
        <div className="border-t border-white/10 bg-[#11141b] xl:hidden">
          <div className="px-4 py-3 space-y-1">
            {links.map((link) => (
              <div key={link.href}>
                <Link href={link.href} onClick={() => setOpen(false)} className="block px-3 py-2 text-sm font-medium text-white/72 hover:text-white">
                  {t(link.label)}
                </Link>
                {link.children && (
                  <div className="pl-6 space-y-1">
                    {link.children.map((child) => (
                      <Link key={child.href} href={child.href} onClick={() => setOpen(false)} className="block px-3 py-1.5 text-sm text-white/50 hover:text-white">
                        {child.label}
                      </Link>
                    ))}
                  </div>
                )}
              </div>
            ))}
            <div className="flex flex-col gap-2 border-t border-white/10 pt-3">
              <Link href="/site/qualify" onClick={() => setOpen(false)} className="block border border-[#a5b4fc]/70 px-4 py-2 text-center text-sm font-semibold text-[#a5b4fc]">
                {t("checkQualify")}
              </Link>
              <Link href={loginHref} onClick={() => setOpen(false)} className="px-3 py-2 text-sm font-medium text-white/72 hover:text-white">
                {t("login")}
              </Link>
              <Link href="/site/apply" onClick={() => setOpen(false)} className="block bg-[#a5b4fc] px-4 py-2 text-center text-sm font-semibold text-[#11141b]">
                {t("applyNow")}
              </Link>
            </div>
          </div>
        </div>
      )}
    </header>
  )
}
