"use client"

import { createContext, useContext } from "react"
import type { LenderIdentity } from "@/lib/config/identity-schema"
import { ZA_SITE, type SiteJurisdiction } from "@/lib/website/site-jurisdiction"

const WebsiteIdentityContext = createContext<LenderIdentity | null>(null)
const WebsiteJurisdictionContext = createContext<SiteJurisdiction>(ZA_SITE)

/** Hands the server-read lender identity and jurisdiction to the website's client components. */
export function WebsiteIdentityProvider({
  identity,
  jurisdiction = ZA_SITE,
  children,
}: {
  identity: LenderIdentity
  jurisdiction?: SiteJurisdiction
  children: React.ReactNode
}) {
  return (
    <WebsiteJurisdictionContext.Provider value={jurisdiction}>
      <WebsiteIdentityContext.Provider value={identity}>{children}</WebsiteIdentityContext.Provider>
    </WebsiteJurisdictionContext.Provider>
  )
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

/** The lender's jurisdiction, as the server read it (ZA when the provider was given none). */
export function useWebsiteJurisdiction(): SiteJurisdiction {
  return useContext(WebsiteJurisdictionContext)
}
