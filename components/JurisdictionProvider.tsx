"use client"

import { setActiveJurisdiction } from "@/lib/jurisdiction/active"
import type { Currency, Jurisdiction } from "@/lib/jurisdiction/profiles"

/**
 * Hands the lender's jurisdiction and currency (read on the server by the root
 * layout) to the browser's copy of lib/jurisdiction/active.ts, so a client
 * component's formatZAR/validator answers what the server rendered. It sets the
 * value during render, before any child renders, which is also what makes SSR
 * and hydration agree. The value never changes within a page load.
 */
export function JurisdictionProvider({
  jurisdiction,
  currency,
  children,
}: {
  jurisdiction: Jurisdiction
  currency: Currency
  children: React.ReactNode
}) {
  setActiveJurisdiction({ jurisdiction, currency })
  return <>{children}</>
}
