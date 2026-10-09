export const CLIENT_DETAIL_TABS = [
  "applications",
  "loans",
  "documents",
  "kyc",
  "compliance",
  "consent",
  "comms",
  "bureau",
] as const

export type ClientDetailTab = (typeof CLIENT_DETAIL_TABS)[number]

const DEFAULT_TAB: ClientDetailTab = "applications"

/** Validate a `?tab=` query value against the client detail page's known tabs, falling back to the default. */
export function resolveClientTab(tab: string | undefined): ClientDetailTab {
  return (CLIENT_DETAIL_TABS as readonly string[]).includes(tab ?? "")
    ? (tab as ClientDetailTab)
    : DEFAULT_TAB
}
