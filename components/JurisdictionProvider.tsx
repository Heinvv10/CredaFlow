"use client"

import { useState } from "react"
import { setActiveJurisdiction } from "@/lib/jurisdiction/active"
import type { Currency, Jurisdiction } from "@/lib/jurisdiction/profiles"

/**
 * Hands the lender's jurisdiction and currency (read on the server by the root
 * layout) to the browser's copy of lib/jurisdiction/active.ts, so a client
 * component's formatZAR/validator answers what the server rendered. It sets the
 * value during render, before any child renders, which is also what makes SSR
 * and hydration agree. The value never changes within a page load, so it is set
 * once per mounted provider (a state initializer), not on every render.
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
  useState(() => {
    setActiveJurisdiction({ jurisdiction, currency })
    return true
  })
  return <>{children}</>
}
