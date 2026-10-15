import Link from "next/link"
import { PORTAL_UNAVAILABLE_MESSAGE, REGISTRATIONS_CLOSED_MESSAGE } from "@/lib/portal/portal-policy"

/**
 * What a portal page shows while the lender has the portal switched off
 * (TenantConfig.featurePortal), or, for the registration page, while new
 * registrations are closed. No session, no data, no links into the portal.
 */
export function PortalUnavailable({ reason = "disabled" }: { reason?: "disabled" | "registrations_closed" }) {
  const closed = reason === "registrations_closed"
  return (
    <main className="cf-app-surface min-h-screen px-4 py-14 text-[var(--cf-text)]">
      <div className="mx-auto w-full max-w-md border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-7 shadow-[var(--cf-shadow-panel)]">
        <p className="mb-3 text-xs font-bold uppercase tracking-[0.24em] text-[var(--cf-brand)]">Client portal</p>
        <h1 className="text-2xl font-semibold">
          {closed ? "Registrations are closed" : "The client portal is not available"}
        </h1>
        <p className="mt-3 text-sm leading-relaxed text-[var(--cf-text-muted)]">
          {closed ? REGISTRATIONS_CLOSED_MESSAGE : PORTAL_UNAVAILABLE_MESSAGE}
        </p>
        {closed && (
          <Link href="/portal/login" className="mt-6 inline-block text-sm font-semibold text-[var(--cf-brand)] underline">
            Sign in to an existing account
          </Link>
        )}
      </div>
    </main>
  )
}
