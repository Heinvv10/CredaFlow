import Link from "next/link"
import { DealerSignOut } from "./DealerSignOut"

type Props = {
  user: { email: string; name: string; admin: boolean }
  dealerName: string
  children: React.ReactNode
}

/** The dealer portal frame: the dealer's own name, its deals, commission and (admins) users. */
export function DealerShell({ user, dealerName, children }: Props) {
  const links = [
    { href: "/dealer", label: "Deals" },
    { href: "/dealer/deals/new", label: "New deal" },
    { href: "/dealer/commission", label: "Commission" },
    ...(user.admin ? [{ href: "/dealer/users", label: "Users" }] : []),
  ]
  return (
    <div className="cf-app-surface min-h-screen">
      <header className="border-b border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <div className="flex flex-col">
            <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--cf-brand)]">Dealer portal</span>
            {dealerName ? <span className="text-sm font-semibold text-[var(--cf-text)]">{dealerName}</span> : null}
          </div>
          <nav className="flex flex-wrap gap-4 text-sm">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className="text-[var(--cf-text-secondary)] hover:text-[var(--cf-text)]">{l.label}</Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-[var(--cf-text-muted)]">
            <span>{user.name} · {user.admin ? "Admin" : "Sales"}</span>
            <DealerSignOut />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}

/** A page title block for portal pages. */
export function DealerPageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-2xl font-bold text-[var(--cf-text)]">{title}</h1>
        {subtitle ? <p className="mt-1 text-sm text-[var(--cf-text-secondary)]">{subtitle}</p> : null}
      </div>
      {actions}
    </div>
  )
}
