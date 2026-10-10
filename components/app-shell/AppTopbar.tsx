import { NotificationBell } from "./NotificationBell"
import { ThemeToggle } from "@/components/ThemeToggle"
import { createHash } from "node:crypto"
import { getLenderBrandName } from "@/lib/config/identity"
import { getLenderLogo } from "@/lib/config/lender-logo"
import { getResolvedTenantId } from "@/lib/tenant"

type AppTopbarProps = {
  user: {
    name: string | null
    email: string
    role: string
  }
}

function getInitials(name: string | null, email: string) {
  if (name) {
    const parts = name.trim().split(" ")
    if (parts.length >= 2) return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    return parts[0].slice(0, 2).toUpperCase()
  }
  return email.slice(0, 2).toUpperCase()
}

function formatRole(role: string) {
  return role.replace(/_/g, " ").toLowerCase().replace(/\b\w/g, c => c.toUpperCase())
}

export async function AppTopbar({ user }: AppTopbarProps) {
  const tenantId = await getResolvedTenantId()
  const brandName = await getLenderBrandName(tenantId)
  // The uploaded letterhead logo when its file is present and intact
  // (lib/config/lender-logo.ts), else the tenant's name as text. The hash in
  // the URL makes a new upload show without waiting out the browser cache.
  const logo = await getLenderLogo(tenantId)
  const logoVersion = logo ? createHash("sha256").update(logo).digest("hex").slice(0, 12) : null
  return (
    <header className="fixed inset-x-0 top-[var(--cf-demo-banner-h)] z-50 flex h-14 items-center justify-between border-b border-[var(--cf-border-subtle)] bg-[var(--cf-shell-bg)] px-4 backdrop-blur lg:px-6">
      {/* pl-12 on mobile clears the fixed hamburger (lg:hidden, left-3 + w-9)
          so it no longer overlaps the logo (audit N-12). */}
      <div className="flex min-w-0 items-center gap-4 pl-12 lg:pl-0">
        {logoVersion ? (
          // eslint-disable-next-line @next/next/no-img-element -- an authenticated API response, not a static asset
          <img
            src={`/api/settings/identity/logo?v=${logoVersion}`}
            alt={brandName}
            className="h-8 w-auto max-w-[160px] rounded bg-white object-contain px-1"
          />
        ) : (
          <p className="truncate text-base font-bold text-[var(--cf-text)]">{brandName}</p>
        )}
        <div className="hidden h-5 w-px bg-[var(--cf-border-subtle)] sm:block" />
        <p className="hidden truncate text-[11px] font-semibold uppercase tracking-[0.18em] text-[var(--cf-text-muted)] sm:block">
          Staff Workspace
        </p>
      </div>

      <div className="flex items-center gap-3">
        <NotificationBell />
        <ThemeToggle className="hidden sm:inline-flex" />
        <div className="hidden text-right leading-tight sm:block">
          <p className="text-xs font-medium text-[var(--cf-text-secondary)]">{user.name || user.email}</p>
          <p className="text-[10px] uppercase tracking-[0.12em] text-[var(--cf-text-muted)]">{formatRole(user.role)}</p>
        </div>
        <div className="flex h-9 w-9 items-center justify-center rounded-full border border-[var(--cf-border-strong)] bg-[rgba(79,70,229,0.18)] text-xs font-bold text-[var(--cf-brand-soft)]">
          {getInitials(user.name, user.email)}
        </div>
      </div>
    </header>
  )
}
