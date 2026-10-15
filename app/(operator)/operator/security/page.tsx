import Link from "next/link"
import { notFound, redirect } from "next/navigation"
import { getSession } from "@/lib/auth-session"
import { isOperatorRole } from "@/lib/operator/roles"
import { OperatorTotpEnrol } from "@/components/operator/OperatorTotpEnrol"

export const dynamic = "force-dynamic"

export const metadata = { title: "Two-factor authentication — Operator console" }

// Operator 2FA enrolment: the one page a session held at enrolment reaches
// (lib/proxy/operator-host.ts). Not inside the console layout, which accepts
// TOTP-verified sessions only.
export default async function OperatorSecurityPage() {
  const user = (await getSession())?.user
  if (!user) redirect("/api/auth/expired?callbackUrl=%2Foperator%2Fsecurity")
  if (!isOperatorRole(user.role)) notFound()
  const verified = user.totpVerified === true && user.totpEnrolmentRequired === false

  return (
    <main className="cf-app-surface flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-lg rounded-xl border border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] p-8">
        <p className="mb-2 text-[10px] font-semibold uppercase tracking-[0.28em] text-[var(--cf-brand)]">Operator console</p>
        <h1 className="text-2xl font-bold text-[var(--cf-text)]">Two-factor authentication</h1>
        {verified ? (
          <p className="mt-4 text-sm text-[var(--cf-text-secondary)]">
            Two-factor authentication is on for {user.email}. <Link href="/operator" className="text-[var(--cf-brand-alt)] hover:underline">Back to the console</Link>
          </p>
        ) : (
          <OperatorTotpEnrol email={user.email} />
        )}
      </div>
    </main>
  )
}
