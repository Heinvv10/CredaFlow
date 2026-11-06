/**
 * What differs between the places a lender can operate. Pure data and no
 * imports from the database, so client components and scripts can read it.
 * `TenantConfig.jurisdiction` / `currency` choose the entry; ./active.ts holds
 * the one this deployment runs as.
 */
export const JURISDICTIONS = ["ZA", "LS", "KE"] as const
export type Jurisdiction = (typeof JURISDICTIONS)[number]

export const CURRENCIES = ["ZAR", "LSL", "KES"] as const
export type Currency = (typeof CURRENCIES)[number]

/** Client-capture facts: what an ID, mobile number, region and postcode look like. Data only. */
export interface CaptureProfile {
  /** SA_ID: 13 digits, Luhn, date of birth and gender encoded. LS_ID and KE_ID: shape only (lib/jurisdiction/national-id.ts). */
  idScheme: "SA_ID" | "LS_ID" | "KE_ID"
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
  /** Country calling code, digits only ("27"). */
  dialCode: string
  /**
   * The country code that replaces the trunk 0 of a ten-digit local number
   * ("082…", "0712…"): the lender's own dialCode where numbers are written that
   * way. Lesotho has no trunk prefix (eight-digit numbers), so there such a
   * number is South African ("27").
   */
  localZeroDialCode: string
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
  /** The currencies a lender here may be billed in (the database CHECKs hold the same pairs). */
  allowedCurrencies: readonly Currency[]
  /**
   * IANA zone for the lender's calendar. Maseru and Johannesburg have had one
   * UTC+2 offset, with no daylight saving, throughout the system's life, so
   * the SAST-pinned date code gives the right day for both (profiles.test.ts).
   * KNOWN GAP: Nairobi is UTC+3, so between 00:00 and 01:00 EAT the system's
   * date is still yesterday. Data only; the date code does not read it.
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

/**
 * Kenya's 47 counties with the codes of the First Schedule to the Constitution
 * (001 Mombasa … 047 Nairobi City). The code is stored in the address
 * `province` field.
 */
export const KENYA_COUNTIES = [
  { code: "001", label: "Mombasa" },
  { code: "002", label: "Kwale" },
  { code: "003", label: "Kilifi" },
  { code: "004", label: "Tana River" },
  { code: "005", label: "Lamu" },
  { code: "006", label: "Taita-Taveta" },
  { code: "007", label: "Garissa" },
  { code: "008", label: "Wajir" },
  { code: "009", label: "Mandera" },
  { code: "010", label: "Marsabit" },
  { code: "011", label: "Isiolo" },
  { code: "012", label: "Meru" },
  { code: "013", label: "Tharaka-Nithi" },
  { code: "014", label: "Embu" },
  { code: "015", label: "Kitui" },
  { code: "016", label: "Machakos" },
  { code: "017", label: "Makueni" },
  { code: "018", label: "Nyandarua" },
  { code: "019", label: "Nyeri" },
  { code: "020", label: "Kirinyaga" },
  { code: "021", label: "Murang'a" },
  { code: "022", label: "Kiambu" },
  { code: "023", label: "Turkana" },
  { code: "024", label: "West Pokot" },
  { code: "025", label: "Samburu" },
  { code: "026", label: "Trans Nzoia" },
  { code: "027", label: "Uasin Gishu" },
  { code: "028", label: "Elgeyo-Marakwet" },
  { code: "029", label: "Nandi" },
  { code: "030", label: "Baringo" },
  { code: "031", label: "Laikipia" },
  { code: "032", label: "Nakuru" },
  { code: "033", label: "Narok" },
  { code: "034", label: "Kajiado" },
  { code: "035", label: "Kericho" },
  { code: "036", label: "Bomet" },
  { code: "037", label: "Kakamega" },
  { code: "038", label: "Vihiga" },
  { code: "039", label: "Bungoma" },
  { code: "040", label: "Busia" },
  { code: "041", label: "Siaya" },
  { code: "042", label: "Kisumu" },
  { code: "043", label: "Homa Bay" },
  { code: "044", label: "Migori" },
  { code: "045", label: "Kisii" },
  { code: "046", label: "Nyamira" },
  { code: "047", label: "Nairobi City" },
] as const

const PROFILES: Record<Jurisdiction, JurisdictionProfile> = {
  ZA: {
    code: "ZA", ncaRegulated: true, defaultCurrency: "ZAR", allowedCurrencies: ["ZAR"],
    timeZone: "Africa/Johannesburg", timeZoneLabel: "SAST",
    capture: {
      idScheme: "SA_ID", idEncodesDob: true, idAlphanumeric: false, idMaxLength: 13,
      idLabel: "SA ID number",
      idHint: "13-digit South African ID. DOB and gender will be derived if matched.",
      idInvalid: "Not a valid 13-digit SA ID number",
      idRefusal: "A valid 13-digit SA ID number is required",
      idApplyRefusal: "Please enter a valid 13-digit South African ID number.",
      mobilePatterns: [/^\+27[6-8]\d{8}$/, /^0[6-8]\d{8}$/],
      mobileAllowSpaces: false, dialCode: "27", localZeroDialCode: "27",
      mobileMessage: "Use +27… or 0… mobile format",
      mobileExamples: "a South African mobile number (e.g. 0821234567 or +27821234567)",
      regionLabel: "Province", regions: SA_PROVINCES,
      regionMessage: "Use a SA province code (EC, FS, GP, KZN, LP, MP, NC, NW, WC)",
      postalDigits: 4, postalMessage: "Use a 4-digit SA postal code",
    },
  },
  LS: {
    // The rand is legal tender in Lesotho.
    code: "LS", ncaRegulated: false, defaultCurrency: "LSL", allowedCurrencies: ["LSL", "ZAR"],
    timeZone: "Africa/Maseru", timeZoneLabel: "CAT",
    capture: {
      idScheme: "LS_ID", idEncodesDob: false, idAlphanumeric: true, idMaxLength: 15,
      idLabel: "National ID number",
      idHint: "Lesotho national ID. Date of birth and gender are entered by hand.",
      idInvalid: "Not a valid Lesotho national ID number",
      idRefusal: "A valid Lesotho national ID number is required",
      idApplyRefusal: "Please enter a valid Lesotho national ID number.",
      // Vodacom Lesotho 5x, Econet 6x (lib/jurisdiction/phone-region.ts).
      mobilePatterns: [/^\+266[56]\d{7}$/, /^[56]\d{7}$/],
      mobileAllowSpaces: true, dialCode: "266", localZeroDialCode: "27",
      mobileMessage: "Use +266… or 8-digit mobile format",
      mobileExamples: "a Lesotho mobile number (e.g. 58123456 or +26658123456)",
      regionLabel: "District", regions: LESOTHO_DISTRICTS,
      regionMessage: `Use a Lesotho district code (${LESOTHO_DISTRICTS.map((d) => d.code).join(", ")})`,
      // Maseru is 100. MEDIUM confidence.
      postalDigits: 3, postalMessage: "Use a 3-digit Lesotho postal code",
    },
  },
  // DRAFT: every Kenyan fact here is UNVERIFIED until the lender's Kenyan counsel confirms it.
  KE: {
    code: "KE", ncaRegulated: false, defaultCurrency: "KES", allowedCurrencies: ["KES"],
    timeZone: "Africa/Nairobi", timeZoneLabel: "EAT",
    capture: {
      // UNVERIFIED: shape only, 8-digit national ID or 9-digit Maisha Namba (lib/jurisdiction/national-id.ts).
      idScheme: "KE_ID", idEncodesDob: false, idAlphanumeric: false, idMaxLength: 9,
      idLabel: "National ID number",
      idHint: "Kenyan national ID (8 digits) or Maisha Namba (9 digits). Date of birth and gender are entered by hand.",
      idInvalid: "Not a valid Kenyan national ID number",
      idRefusal: "A valid Kenyan national ID number is required",
      idApplyRefusal: "Please enter a valid Kenyan national ID number.",
      // Mobiles 07xx and 010x/011x; landlines (020 Nairobi and others) are refused (lib/jurisdiction/phone-region.ts).
      mobilePatterns: [/^\+254(7\d{8}|1[01]\d{7})$/, /^0(7\d{8}|1[01]\d{7})$/],
      mobileAllowSpaces: true, dialCode: "254", localZeroDialCode: "254",
      mobileMessage: "Use +254… or 07…/01… mobile format",
      mobileExamples: "a Kenyan mobile number (e.g. 0712345678 or +254712345678)",
      regionLabel: "County", regions: KENYA_COUNTIES,
      regionMessage: "Use a Kenyan county code (001 to 047)",
      // Nairobi GPO is 00100.
      postalDigits: 5, postalMessage: "Use a 5-digit Kenyan postal code",
    },
  },
}

export function profileFor(code: Jurisdiction): JurisdictionProfile {
  return PROFILES[code]
}

/** May a lender in `jurisdiction` be billed in `currency`? (ZA rand only, LS loti or rand, KE shillings only.) */
export function currencyAllowed(jurisdiction: Jurisdiction, currency: Currency): boolean {
  return PROFILES[jurisdiction].allowedCurrencies.includes(currency)
}

export function parseJurisdiction(value: unknown): Jurisdiction {
  if (typeof value === "string" && (JURISDICTIONS as readonly string[]).includes(value)) return value as Jurisdiction
  throw new Error(`Unknown jurisdiction "${String(value)}": expected one of ${JURISDICTIONS.join(", ")}`)
}

export function parseCurrency(value: unknown): Currency {
  if (typeof value === "string" && (CURRENCIES as readonly string[]).includes(value)) return value as Currency
  throw new Error(`Unknown currency "${String(value)}": expected one of ${CURRENCIES.join(", ")}`)
}
