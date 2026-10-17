"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { signOut } from "next-auth/react"
import { LogOut, Menu } from "lucide-react"
import { ThemeToggle } from "@/components/ThemeToggle"
import { LanguageSwitcher } from "@/components/i18n/LanguageSwitcher"
import { buildPortalNavigation, type NavItem } from "@/lib/navigation"
import { useT } from "@/lib/i18n/client"
import type { Locale } from "@/lib/i18n/locales"
import type { MessageKey } from "@/lib/i18n/translate"
import { cn } from "@/lib/utils"

// Bottom nav on mobile shows a subset of the main portal nav: five items, plus
// Business for a client who may act for an entity (the same condition as the
// sidebar link). Resolved by href so it survives reordering of the portal
// navigation. Throws if any href is missing or mistyped — preferred over
// silently dropping items from the bottom nav (which a `.filter(Boolean)` would do).
const MOBILE_HREFS = ["/portal", "/portal/applications", "/portal/documents", "/portal/payment", "/portal/profile"] as const

export function portalMobileItems(business: boolean): NavItem[] {
  const navigation = buildPortalNavigation(null, { business })
  const hrefs: string[] = business ? ["/portal", "/portal/business", ...MOBILE_HREFS.slice(1)] : [...MOBILE_HREFS]
  return hrefs.map(h => {
    const item = navigation.find(i => i.href === h)
    if (!item) {
      throw new Error(`PortalSidebar: MOBILE_HREFS includes "${h}" but it is not present in the portal navigation`)
    }
    return item
  })
}
const mobileItems = portalMobileItems(false)
const mobileItemsWithBusiness = portalMobileItems(true)

// Labels are translated by destination, so lib/navigation.ts (shared with the
// staff sidebar) keeps its English labels. Support is the one external item
// (a wa.me link).
const NAV_LABEL_KEYS: Record<string, MessageKey<"portalShell">> = {
  "/portal": "navOverview",
  "/portal/business": "navBusiness",
  "/portal/applications": "navApplications",
  "/portal/apply": "navApply",
  "/portal/loans": "navLoans",
  "/portal/insurance": "navInsurance",
  "/portal/documents": "navDocuments",
  "/portal/statement": "navStatements",
  "/portal/payment": "navPayment",
  "/portal/notifications": "navNotifications",
  "/portal/profile": "navProfile",
}

function isActive(pathname: string, href: string) {
  if (href === "/portal") return pathname === "/portal"
  return pathname === href || pathname.startsWith(`${href}/`)
}

type PortalSidebarProps = {
  userName: string
  userEmail: string
  brandName: string
  /** The lender's logo (lib/config/lender-logo.ts publicLenderLogoSrc); null shows the name alone. */
  logoSrc?: string | null
  /** The lender's `publicWhatsappE164`; null hides the Support link. */
  whatsappE164: string | null
  /** The client may act for a business entity (asset finance). */
  showBusiness?: boolean
  /** The tenant's enabled languages; fewer than two hides the switcher. */
  enabledLocales?: readonly Locale[]
}

export function PortalSidebar({ userName, userEmail, brandName, logoSrc = null, whatsappE164, showBusiness = false, enabledLocales = [] }: PortalSidebarProps) {
  const pathname = usePathname()
  const t = useT("portalShell")
  const label = (item: NavItem) => {
    const key = item.external ? "navSupport" : NAV_LABEL_KEYS[item.href]
    return key ? t(key) : item.label
  }
  const portalNavigation = buildPortalNavigation(whatsappE164, { business: showBusiness })
  const bottomItems = showBusiness ? mobileItemsWithBusiness : mobileItems

  return (
    <>
      <aside className="fixed bottom-0 left-0 top-[var(--cf-demo-banner-h)] z-40 hidden w-60 border-r border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] md:flex md:flex-col">
        <div className="flex h-16 items-center border-b border-[var(--cf-border-subtle)] px-5">
          <div className="min-w-0">
            {logoSrc ? (
              // eslint-disable-next-line @next/next/no-img-element -- a per-tenant API response, not a static asset
              <img src={logoSrc} alt={brandName} className="h-7 w-auto max-w-[180px] rounded bg-white object-contain px-1" />
            ) : (
              <p className="text-xs font-semibold text-[var(--cf-text)]">{brandName}</p>
            )}
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">{t("clientPortal")}</p>
          </div>
        </div>

        <div className="border-b border-[var(--cf-border-subtle)] px-5 py-4">
          <p className="truncate text-sm font-medium text-[var(--cf-text)]">{userName}</p>
          <p className="mt-1 truncate text-xs text-[var(--cf-text-muted)]">{userEmail}</p>
        </div>

        <nav className="flex-1 overflow-y-auto px-3 py-4">
          <div className="space-y-1">
            {portalNavigation.map(item => {
              const Icon = item.icon
              const active = !item.external && isActive(pathname, item.href)
              const linkProps = item.external ? { target: "_blank", rel: "noopener noreferrer" } : {}

              return (
                <Link
                  key={item.href}
                  href={item.href}
                  {...linkProps}
                  className={cn(
                    "flex items-center gap-3 rounded-md border px-3 py-2.5 text-sm font-medium transition-colors",
                    active
                      ? "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.14)] text-[var(--cf-text)]"
                      : "border-transparent text-[var(--cf-text-muted)] hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text-secondary)]"
                  )}
                >
                  <Icon className={cn("h-4 w-4 shrink-0", active && "text-[var(--cf-brand-soft)]")} />
                  <span className="truncate">{label(item)}</span>
                </Link>
              )
            })}
          </div>
        </nav>

        <div className="border-t border-[var(--cf-border-subtle)] p-3">
          <LanguageSwitcher enabled={enabledLocales} className="mb-1 w-full px-3 text-[var(--cf-text-muted)]" />
          <ThemeToggle showLabel className="mb-1 w-full justify-start border-transparent" />
          <button
            onClick={() => signOut({ redirectTo: "/portal/login" })}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text)]"
          >
            <LogOut className="h-4 w-4" />
            {t("signOut")}
          </button>
        </div>
      </aside>

      <details
        className="fixed bottom-20 left-4 z-50 md:hidden"
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.currentTarget.removeAttribute("open")
            event.currentTarget.querySelector("summary")?.focus()
          }
        }}
      >
        <summary className="flex cursor-pointer list-none items-center gap-2 rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] px-4 py-3 text-sm font-semibold text-[var(--cf-text)] shadow-lg">
          <Menu className="h-4 w-4" aria-hidden="true" />{t("menu")}
        </summary>
        <nav aria-label={t("clientPortal")} className="absolute bottom-full left-0 mb-2 max-h-[60dvh] w-64 overflow-y-auto rounded-lg border border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] p-2 shadow-xl">
          {portalNavigation.map(item => (
            <Link
              key={item.href}
              href={item.href}
              {...(item.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              onClick={(event) => event.currentTarget.closest("details")?.removeAttribute("open")}
              aria-current={!item.external && isActive(pathname, item.href) ? "page" : undefined}
              className="block rounded-md px-3 py-3 text-sm text-[var(--cf-text)] hover:bg-[var(--cf-surface-hover)]"
            >{label(item)}</Link>
          ))}
          <button onClick={() => signOut({ redirectTo: "/portal/login" })} className="flex w-full items-center gap-3 border-t border-[var(--cf-border-subtle)] px-3 py-3 text-sm text-[var(--cf-text)]">
            <LogOut className="h-4 w-4" aria-hidden="true" />{t("signOut")}
          </button>
        </nav>
      </details>

      <nav className={cn(
        "fixed inset-x-0 bottom-0 z-50 grid h-16 border-t border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] md:hidden",
        bottomItems.length === 6 ? "grid-cols-6" : "grid-cols-5"
      )}>
        {bottomItems.map(item => {
          const Icon = item.icon
          const active = isActive(pathname, item.href)

          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                "flex flex-col items-center justify-center gap-1 text-[10px] font-medium",
                active ? "text-[var(--cf-brand-soft)]" : "text-[var(--cf-text-muted)]"
              )}
            >
              <Icon className="h-4 w-4" />
              <span>{label(item)}</span>
              {active && <span className="h-1 w-1 rounded-full bg-[var(--cf-brand)]" />}
            </Link>
          )
        })}
      </nav>
    </>
  )
}
