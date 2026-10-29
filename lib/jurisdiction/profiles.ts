/**
 * What differs between the places a lender can operate. Pure data and no
 * imports from the database, so client components and scripts can read it.
 * `TenantConfig.jurisdiction` / `currency` choose the entry; ./active.ts holds
 * the one this deployment runs as.
 */
export const JURISDICTIONS = ["ZA", "LS"] as const
export type Jurisdiction = (typeof JURISDICTIONS)[number]

export const CURRENCIES = ["ZAR", "LSL"] as const
export type Currency = (typeof CURRENCIES)[number]

export interface JurisdictionProfile {
  code: Jurisdiction
  /** Credit is regulated by the South African National Credit Act (rate cap, s129, NCR returns). */
  ncaRegulated: boolean
  defaultCurrency: Currency
  /**
   * IANA zone for the lender's calendar. Maseru and Johannesburg have had one
   * UTC+2 offset, with no daylight saving, throughout the system's life, so
   * the SAST-pinned date code gives the right day for both (profiles.test.ts).
   */
  timeZone: string
  /** Label the staff UI may show beside a time. */
  timeZoneLabel: string
}

const PROFILES: Record<Jurisdiction, JurisdictionProfile> = {
  ZA: { code: "ZA", ncaRegulated: true, defaultCurrency: "ZAR", timeZone: "Africa/Johannesburg", timeZoneLabel: "SAST" },
  LS: { code: "LS", ncaRegulated: false, defaultCurrency: "LSL", timeZone: "Africa/Maseru", timeZoneLabel: "CAT" },
}

export function profileFor(code: Jurisdiction): JurisdictionProfile {
  return PROFILES[code]
}

export function parseJurisdiction(value: unknown): Jurisdiction {
  if (typeof value === "string" && (JURISDICTIONS as readonly string[]).includes(value)) return value as Jurisdiction
  throw new Error(`Unknown jurisdiction "${String(value)}": expected one of ${JURISDICTIONS.join(", ")}`)
}

export function parseCurrency(value: unknown): Currency {
  if (typeof value === "string" && (CURRENCIES as readonly string[]).includes(value)) return value as Currency
  throw new Error(`Unknown currency "${String(value)}": expected one of ${CURRENCIES.join(", ")}`)
}
