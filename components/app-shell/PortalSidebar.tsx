"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { signOut } from "next-auth/react"
import { LogOut } from "lucide-react"
import { ThemeToggle } from "@/components/ThemeToggle"
import { buildPortalNavigation, type NavItem } from "@/lib/navigation"
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

function isActive(pathname: string, href: string) {
  if (href === "/portal") return pathname === "/portal"
  return pathname === href || pathname.startsWith(`${href}/`)
}

type PortalSidebarProps = {
  userName: string
  userEmail: string
  brandName: string
  /** The lender's `publicWhatsappE164`; null hides the Support link. */
  whatsappE164: string | null
  /** The client may act for a business entity (asset finance). */
  showBusiness?: boolean
}

export function PortalSidebar({ userName, userEmail, brandName, whatsappE164, showBusiness = false }: PortalSidebarProps) {
  const pathname = usePathname()
  const portalNavigation = buildPortalNavigation(whatsappE164, { business: showBusiness })
  const bottomItems = showBusiness ? mobileItemsWithBusiness : mobileItems

  return (
    <>
      <aside className="fixed bottom-0 left-0 top-[var(--cf-demo-banner-h)] z-40 hidden w-60 border-r border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] md:flex md:flex-col">
        <div className="flex h-16 items-center border-b border-[var(--cf-border-subtle)] px-5">
          <div>
            <p className="text-xs font-semibold text-[var(--cf-text)]">{brandName}</p>
            <p className="mt-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-brand)]">Client Portal</p>
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
                  <span className="truncate">{item.label}</span>
                </Link>
              )
            })}
          </div>
        </nav>

        <div className="border-t border-[var(--cf-border-subtle)] p-3">
          <ThemeToggle showLabel className="mb-1 w-full justify-start border-transparent" />
          <button
            onClick={() => signOut({ redirectTo: "/portal/login" })}
            className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text)]"
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </button>
        </div>
      </aside>

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
              <span>{item.label}</span>
              {active && <span className="h-1 w-1 rounded-full bg-[var(--cf-brand)]" />}
            </Link>
          )
        })}
      </nav>
    </>
  )
}
