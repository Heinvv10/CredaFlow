"use client"

import Link from "next/link"
import { usePathname } from "next/navigation"
import { signOut } from "next-auth/react"
import { LogOut, Menu, X } from "lucide-react"
import { useState } from "react"
import { ThemeToggle } from "@/components/ThemeToggle"
import { badgeDescription, staffNavigation, type NavGroup, type NavItem, type StaffBadgeKey } from "@/lib/navigation"
import { hasMinRole, type UserRole } from "@/lib/permissions"
import { cn } from "@/lib/utils"



type AppSidebarProps = {
  badges?: Partial<Record<StaffBadgeKey, number>>
  featureCrm?: boolean
  featureIms?: boolean
  featureBureauSubmission?: boolean
  featureAssetFinance?: boolean
  role?: UserRole
}

type Features = { featureCrm: boolean; featureIms: boolean; featureBureauSubmission: boolean; featureAssetFinance: boolean }

export function groupEnabled(group: NavGroup, features: Features) {
  if (group.feature === "crm") return features.featureCrm
  if (group.feature === "ims") return features.featureIms
  if (group.feature === "bureauSubmission") return features.featureBureauSubmission
  if (group.feature === "assetFinance") return features.featureAssetFinance
  return true
}

export function itemEnabled(item: NavItem, role: UserRole) {
  if (!item.minRole) return true
  return hasMinRole(role, item.minRole)
}

function routeMatches(pathname: string, href: string) {
  if (href === "/dashboard") return pathname === "/dashboard" || pathname === "/"
  return pathname === href || pathname.startsWith(`${href}/`)
}

function activeHref(pathname: string, groups: NavGroup[], features: Features) {
  return groups
    .filter(group => groupEnabled(group, features))
    .flatMap(group => group.items)
    .filter(item => routeMatches(pathname, item.href))
    .sort((a, b) => b.href.length - a.href.length)[0]?.href
}

export function AppSidebar({
  badges = {},
  featureCrm = false,
  featureIms = false,
  featureBureauSubmission = false,
  featureAssetFinance = false,
  role = "READONLY",
}: AppSidebarProps) {
  const pathname = usePathname()
  const [mobileOpen, setMobileOpen] = useState(false)
  const features = { featureCrm, featureIms, featureBureauSubmission, featureAssetFinance }
  const currentHref = activeHref(pathname, staffNavigation, features)

  const closeMobile = () => setMobileOpen(false)

  const content = (
    <div className="flex h-full flex-col border-r border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)]">
      <div className="flex h-14 items-center border-b border-[var(--cf-border-subtle)] px-5">
        <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-[var(--cf-brand)]">
          Authenticated Workspace
        </p>
      </div>

      <nav className="flex-1 overflow-y-auto px-3 py-4">
        {staffNavigation
          .filter(group => groupEnabled(group, features))
          .map(group => (
            <div key={group.label} className="mb-5">
              <p className="mb-2 px-3 text-[10px] font-semibold uppercase tracking-[0.16em] text-[var(--cf-text-muted)]">
                {group.label}
              </p>
              <div className="space-y-1">
                {group.items.filter(item => itemEnabled(item, role)).map(item => {
                  const Icon = item.icon
                  const active = currentHref === item.href
                  const badge = item.badgeKey ? badges[item.badgeKey] : undefined

                  return (
                    <Link
                      key={item.href}
                      href={item.href}
                      onClick={closeMobile}
                      className={cn(
                        "group flex items-center gap-3 rounded-md border px-3 py-2.5 text-sm font-medium transition-colors",
                        active
                          ? "border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.14)] text-[var(--cf-text)]"
                          : "border-transparent text-[var(--cf-text-muted)] hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text-secondary)]"
                      )}
                    >
                      <Icon className={cn("h-4 w-4 shrink-0", active && "text-[var(--cf-brand-soft)]")} />
                      <span className="min-w-0 flex-1 truncate">{item.label}</span>
                      {/* `item.badgeKey` is redundant at runtime — `badge` is
                          only defined when it is set — and is here to narrow
                          the type for badgeDescription(). It gates nothing.

                          The description is real sr-only TEXT, not an
                          aria-label on this span: a bare <span> is
                          role="generic", which is excluded from name-from-
                          author, so Chromium and Firefox drop the attribute and
                          announce the digits alone — the exact ambiguity this
                          exists to remove. `title` carries the same words to a
                          sighted mouse user on hover. */}
                      {badge !== undefined && badge > 0 && item.badgeKey && (
                        <span
                          className="rounded-full bg-[var(--cf-brand)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--cf-on-brand)]"
                          title={badgeDescription(item.badgeKey, badge)}
                        >
                          <span aria-hidden="true">{badge > 99 ? "99+" : badge}</span>
                          <span className="sr-only">
                            {badgeDescription(item.badgeKey, badge)}
                          </span>
                        </span>
                      )}
                      {active && <span className="h-1.5 w-1.5 rounded-full bg-[var(--cf-brand)]" />}
                    </Link>
                  )
                })}
              </div>
            </div>
          ))}
      </nav>

      <div className="border-t border-[var(--cf-border-subtle)] p-3">
        <ThemeToggle
          showLabel
          className="mb-1 w-full justify-start border-transparent sm:hidden"
        />
        <button
          onClick={() => signOut({ callbackUrl: "/login" })}
          className="flex w-full items-center gap-3 rounded-md px-3 py-2.5 text-sm font-medium text-[var(--cf-text-muted)] transition-colors hover:bg-[var(--cf-surface-hover)] hover:text-[var(--cf-text)]"
        >
          <LogOut className="h-4 w-4" />
          Sign out
        </button>
      </div>
    </div>
  )

  return (
    <>
      <button
        type="button"
        onClick={() => setMobileOpen(v => !v)}
        className="fixed left-3 top-[calc(0.75rem+var(--cf-demo-banner-h))] z-[60] inline-flex h-9 w-9 items-center justify-center rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] text-[var(--cf-text)] lg:hidden"
        aria-label="Toggle navigation"
      >
        {mobileOpen ? <X className="h-4 w-4" /> : <Menu className="h-4 w-4" />}
      </button>

      {mobileOpen && (
        <button
          type="button"
          className="fixed inset-0 z-40 bg-[var(--cf-overlay-bg)] lg:hidden"
          aria-label="Close navigation"
          onClick={() => setMobileOpen(false)}
        />
      )}

      <aside
        className={cn(
          "fixed bottom-0 left-0 top-[calc(3.5rem+var(--cf-demo-banner-h))] z-50 w-[248px] transform transition-transform lg:translate-x-0",
          mobileOpen ? "translate-x-0" : "-translate-x-full"
        )}
      >
        {content}
      </aside>
    </>
  )
}
