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

/** Client-capture facts: what an ID, mobile number, region and postcode look like. Data only. */
export interface CaptureProfile {
  /** SA_ID: 13 digits, Luhn, date of birth and gender encoded. LS_ID: shape only (lib/jurisdiction/national-id.ts). */
  idScheme: "SA_ID" | "LS_ID"
  /** Date of birth and gender can be read from (and checked against) the ID number. */
  idEncodesDob: boolean
  idAlphanumeric: boolean
  idMaxLength: number
  idLabel: string
  idHint: string
  /** Wizard field error. */
  idInvalid: string
  /** Lookup API refusal. */
  idRefusal: string
  /** Website application API refusal. */
  idApplyRefusal: string
  /** Accepted mobile forms (E.164 with +, and local). */
  mobilePatterns: readonly RegExp[]
  /** Spaces are ignored before matching (a Lesotho number is often written "+266 5812 3456"). */
  mobileAllowSpaces: boolean
  mobileMessage: string
  /** "a South African mobile number (e.g. …)" in an API error. */
  mobileExamples: string
  regionLabel: string
  /** Provinces / districts: the codes are stored in the address `province` field. */
  regions: readonly { code: string; label: string }[]
  regionMessage: string
  /** Postcode length in digits. */
  postalDigits: number
  postalMessage: string
}

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
  capture: CaptureProfile
}

const SA_PROVINCES = [
  { code: "EC", label: "Eastern Cape" },
  { code: "FS", label: "Free State" },
  { code: "GP", label: "Gauteng" },
  { code: "KZN", label: "KwaZulu-Natal" },
  { code: "LP", label: "Limpopo" },
  { code: "MP", label: "Mpumalanga" },
  { code: "NC", label: "Northern Cape" },
  { code: "NW", label: "North West" },
  { code: "WC", label: "Western Cape" },
] as const

export const LESOTHO_DISTRICTS = [
  { code: "BE", label: "Berea" },
  { code: "BB", label: "Butha-Buthe" },
  { code: "LE", label: "Leribe" },
  { code: "MF", label: "Mafeteng" },
  { code: "MS", label: "Maseru" },
  { code: "MH", label: "Mohale's Hoek" },
  { code: "MK", label: "Mokhotlong" },
  { code: "QN", label: "Qacha's Nek" },
  { code: "QT", label: "Quthing" },
  { code: "TT", label: "Thaba-Tseka" },
] as const

const PROFILES: Record<Jurisdiction, JurisdictionProfile> = {
  ZA: {
    code: "ZA", ncaRegulated: true, defaultCurrency: "ZAR", timeZone: "Africa/Johannesburg", timeZoneLabel: "SAST",
    capture: {
      idScheme: "SA_ID", idEncodesDob: true, idAlphanumeric: false, idMaxLength: 13,
      idLabel: "SA ID number",
      idHint: "13-digit South African ID. DOB and gender will be derived if matched.",
      idInvalid: "Not a valid 13-digit SA ID number",
      idRefusal: "A valid 13-digit SA ID number is required",
      idApplyRefusal: "Please enter a valid 13-digit South African ID number.",
      mobilePatterns: [/^\+27[6-8]\d{8}$/, /^0[6-8]\d{8}$/],
      mobileAllowSpaces: false,
      mobileMessage: "Use +27… or 0… mobile format",
      mobileExamples: "a South African mobile number (e.g. 0821234567 or +27821234567)",
      regionLabel: "Province", regions: SA_PROVINCES,
      regionMessage: "Use a SA province code (EC, FS, GP, KZN, LP, MP, NC, NW, WC)",
      postalDigits: 4, postalMessage: "Use a 4-digit SA postal code",
    },
  },
  LS: {
    code: "LS", ncaRegulated: false, defaultCurrency: "LSL", timeZone: "Africa/Maseru", timeZoneLabel: "CAT",
    capture: {
      idScheme: "LS_ID", idEncodesDob: false, idAlphanumeric: true, idMaxLength: 15,
      idLabel: "National ID number",
      idHint: "Lesotho national ID. Date of birth and gender are entered by hand.",
      idInvalid: "Not a valid Lesotho national ID number",
      idRefusal: "A valid Lesotho national ID number is required",
      idApplyRefusal: "Please enter a valid Lesotho national ID number.",
      // Vodacom Lesotho 5x, Econet 6x (lib/jurisdiction/phone-region.ts).
      mobilePatterns: [/^\+266[56]\d{7}$/, /^[56]\d{7}$/],
      mobileAllowSpaces: true,
      mobileMessage: "Use +266… or 8-digit mobile format",
      mobileExamples: "a Lesotho mobile number (e.g. 58123456 or +26658123456)",
      regionLabel: "District", regions: LESOTHO_DISTRICTS,
      regionMessage: `Use a Lesotho district code (${LESOTHO_DISTRICTS.map((d) => d.code).join(", ")})`,
      // Maseru is 100. MEDIUM confidence.
      postalDigits: 3, postalMessage: "Use a 3-digit Lesotho postal code",
    },
  },
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
