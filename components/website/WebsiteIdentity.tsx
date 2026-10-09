"use client"

import { createContext, useContext } from "react"
import type { LenderIdentity } from "@/lib/config/identity-schema"

const WebsiteIdentityContext = createContext<LenderIdentity | null>(null)

/** Hands the server-read lender identity to the website's client components. */
export function WebsiteIdentityProvider({ identity, children }: { identity: LenderIdentity; children: React.ReactNode }) {
  return <WebsiteIdentityContext.Provider value={identity}>{children}</WebsiteIdentityContext.Provider>
}

/**
 * The lender identity for a client component on the website. Only ever
 * rendered inside WebsiteShell, which renders nothing of the site without an
 * identity, so a missing provider is a wiring bug and throws.
 */
export function useWebsiteIdentity(): LenderIdentity {
  const identity = useContext(WebsiteIdentityContext)
  if (!identity) throw new Error("useWebsiteIdentity must be used inside WebsiteShell")
  return identity
}
