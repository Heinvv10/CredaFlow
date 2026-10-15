import type { Metadata } from "next"
import {
  PASQ_LINK_REJECTION_MESSAGE,
  resolvePasqLinkToken,
} from "@/lib/compliance/pasq-link-token.server"
import { getLenderIdentity } from "@/lib/config/identity"
import { getResolvedTenantId } from "@/lib/tenant"
import { PasqLinkAcknowledge } from "./PasqLinkAcknowledge"
import { isPortalEnabled } from "@/lib/portal/portal-policy"
import { PortalUnavailable } from "@/components/portal/PortalUnavailable"

type PageProps = { params: Promise<{ token: string }> }

// The page holds a live credential in its URL and consumer document content.
// It must never be cached, prerendered, or indexed.
export const dynamic = "force-dynamic"
export const metadata: Metadata = {
  title: "Your quotation",
  robots: { index: false, follow: false },
}

/**
 * Public consumer surface for the one-time PASQ link (NCA s.92(1)).
 *
 * Deliberately outside the (portal) route group: that group's layout redirects
 * anyone without a session to /portal/login, and the whole point of this
 * surface is that the consumer has no account. Origination is telephonic and
 * online, so for most consumers this page IS how the quotation is given to
 * them.
 */
export default async function PasqLinkPage({ params }: PageProps) {
  const { token } = await params
  const resolved = await resolvePasqLinkToken(token)
  const { tradingName } = await getLenderIdentity(
    resolved.ok ? resolved.link.tenantId : await getResolvedTenantId(),
  )

  if (!resolved.ok) {
    return (
      <main className="mx-auto flex min-h-screen max-w-xl flex-col justify-center px-5 py-10">
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-6 text-amber-900">
          <h1 className="text-lg font-semibold">This link cannot be opened</h1>
          <p className="mt-2 text-sm">{PASQ_LINK_REJECTION_MESSAGE[resolved.reason]}</p>
          <p className="mt-4 text-sm">
            Please contact your {tradingName} consultant, who can send you a
            new link.
          </p>
        </div>
      </main>
    )
  }

  // The lender switched its portal off: its borrower-facing links close too.
  if (!(await isPortalEnabled(resolved.link.tenantId))) return <PortalUnavailable />

  const documentUrl = `/api/pasq-link/${token}/document`

  return (
    <main className="mx-auto max-w-3xl px-5 py-8">
      <header className="mb-6">
        <p className="text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {tradingName}
        </p>
        <h1 className="mt-1 text-2xl font-semibold">
          Your Pre-Agreement Statement &amp; Quotation
        </h1>
        <p className="mt-2 text-sm text-neutral-600">
          Please read this document in full, then confirm below that you
          received it. We are required to give you this quotation before you
          sign a credit agreement.
        </p>
      </header>

      <section className="mb-6">
        <iframe referrerPolicy="no-referrer"
          src={documentUrl}
          title="Pre-Agreement Statement and Quotation"
          className="h-[70vh] w-full rounded-lg border border-neutral-300 bg-white"
        />
        <p className="mt-2 text-sm">
          <a
            href={documentUrl}
            target="_blank"
            rel="noreferrer noopener"
            className="font-semibold underline"
          >
            Open the quotation in a new tab
          </a>{" "}
          if it does not display above.
        </p>
      </section>

      <PasqLinkAcknowledge token={token} />
    </main>
  )
}
