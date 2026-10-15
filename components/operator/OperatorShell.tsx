import Link from "next/link"
import { OperatorSignOut } from "./OperatorSignOut"

type Props = {
  user: { email: string; role: "OPERATOR_ADMIN" | "OPERATOR_SUPPORT" }
  children: React.ReactNode
}

/** The operator console frame: no lender branding, no lender navigation. */
export function OperatorShell({ user, children }: Props) {
  const links = [
    { href: "/operator", label: "Lenders" },
    { href: "/operator/usage", label: "Usage" },
    { href: "/operator/grants", label: "My support grants" },
    ...(user.role === "OPERATOR_ADMIN"
      ? [{ href: "/operator/lenders/new", label: "New lender" }, { href: "/operator/users", label: "Operator users" }]
      : []),
  ]
  return (
    <div className="cf-app-surface min-h-screen">
      <header className="border-b border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)]">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <span className="text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--cf-brand)]">Operator console</span>
          <nav className="flex flex-wrap gap-4 text-sm">
            {links.map((l) => (
              <Link key={l.href} href={l.href} className="text-[var(--cf-text-secondary)] hover:text-[var(--cf-text)]">{l.label}</Link>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-xs text-[var(--cf-text-muted)]">
            <span>{user.email} · {user.role === "OPERATOR_ADMIN" ? "Admin" : "Support"}</span>
            <OperatorSignOut />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">{children}</main>
    </div>
  )
}

/** A page title block for console pages. */
export function OperatorPageTitle({ title, subtitle, actions }: { title: string; subtitle?: string; actions?: React.ReactNode }) {
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
