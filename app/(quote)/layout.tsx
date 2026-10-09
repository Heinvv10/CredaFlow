import type { Metadata } from "next"
import { findLenderIdentity } from "@/lib/config/identity"
import { getResolvedTenantId } from "@/lib/tenant"
import "./quickquote-theme.css"

/**
 * Layout for the isolated QuickQuote host.
 *
 * Deliberately bare: no NavBar, no Footer, no analytics, no JSON-LD. This tree
 * exists to be embedded in an iframe by the marketing site, and everything it
 * loads shares an origin with FSP Solutions' jQuery 1.9.1 bundle. Keeping the
 * surface empty means a compromise of that script reaches nothing of ours.
 *
 * Do not add shared marketing chrome here.
 */
export async function generateMetadata(): Promise<Metadata> {
  const identity = await findLenderIdentity(await getResolvedTenantId())
  return {
    title: identity ? `Insurance quote — ${identity.tradingName}` : "Not configured",
    // The page is an iframe fragment, not a destination. Indexing it would put a
    // chrome-less, context-free quote form into search results next to the real
    // insurance page.
    robots: { index: false, follow: false },
  }
}

export default function QuoteHostLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return <div className="min-h-screen bg-[#11141b] text-white">{children}</div>
}
