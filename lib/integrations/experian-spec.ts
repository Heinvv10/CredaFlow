/**
 * Experian Normal Search V3 — spec-derived, network-free logic.
 * Spec: Experian Normal Search V3 Interface V1.6 (Nov 2025).
 *
 * Everything in this file is fully verifiable from the spec alone (no Swagger,
 * no credentials, no output-layout doc): constants, input validation, the
 * NS_/IMS_ error taxonomy, and request assembly. The HTTP client and the
 * (still-blocked) response parser live in `experian.ts`.
 */

import { isValidSaIdChecksum, crossValidateSaIdWithDob } from "@/lib/ocr/saIdValidationService"

/** SigmaScore band per spec definitions (section 2). This is NOT the TransUnion
 *  scale — `tenantConfig.bureauMinScore` (default 450) must be recalibrated into
 *  this band before cutover, or the score gate never blocks. */
export const SIGMA_SCORE_MIN = 480
export const SIGMA_SCORE_MAX = 710

/** Enquiry purpose codes (spec section 6.3). For origination use AFFORDABILITY
 *  or CREDIT_ASSESSMENT — the chosen code is recorded at the bureau and visible
 *  in others' enquiry history, so pick it deliberately and confirm with Experian. */
export const ENQUIRY_PURPOSE = {
  FRAUD_INVESTIGATION: "1",
  FRAUD_PREVENTION: "2",
  EMPLOYMENT: "3",
  BOOK_ASSESSMENT: "4",
  CREDIT_LIMIT: "5",
  INSURANCE_APPLICATION: "6",
  EDUCATION_EMPLOYMENT: "7",
  UNCLAIMED_FUNDS: "8",
  TRACING: "9",
  SCORE_DEVELOPMENT: "10",
  AFFORDABILITY_ASSESSMENT: "11",
  CREDIT_ASSESSMENT: "12",
  DEBT_REVIEW: "13",
  MARKETING_SERVICES: "14",
  DEBT_COLLECTION: "15",
  ACCOUNT_MANAGEMENT: "16",
  CREDIT_OMBUD_ENQUIRY: "17",
  CONSUMER_ENQUIRY: "18",
  OTHER: "19",
} as const
const VALID_PURPOSE_CODES = new Set<string>(Object.values(ENQUIRY_PURPOSE))

/** Actionable buckets for the spec's NS_/IMS_ error taxonomy. The point is that
 *  a config/branch error is an OPS problem, not a customer decline, and must not
 *  be swallowed as "no bureau data". */
export type ExperianErrorClass =
  | "CONFIG" // branch/auth not set up — ops action, never a customer decline
  | "INPUT" // our request was malformed — our bug
  | "DATA_QUALITY" // consumer data invalid/mismatched/minor — surface to staff
  | "CONSENT" // consent not given — route to consent capture
  | "TRANSIENT" // Experian internal/transient — safe to retry with backoff
  | "UNKNOWN" // unrecognised code — fail closed, alert

const CONFIG_CODES = new Set(["IMS_606", "IMS_608", "NS_203", "NS_204", "NS_205", "NS_206", "NS_207"])
const CONSENT_CODES = new Set(["NS_208", "NS_114"])
const DATA_QUALITY_CODES = new Set(["NS_201", "NS_202", "NS_209"])

export function classifyExperianError(code: string): { errorClass: ExperianErrorClass; retryable: boolean } {
  if (CONFIG_CODES.has(code)) return { errorClass: "CONFIG", retryable: false }
  if (CONSENT_CODES.has(code)) return { errorClass: "CONSENT", retryable: false }
  if (DATA_QUALITY_CODES.has(code)) return { errorClass: "DATA_QUALITY", retryable: false }
  // NS_988–NS_999 are critical/internal — transient, safe to retry with backoff.
  const ns = /^NS_(\d{3})$/.exec(code)
  if (ns && Number(ns[1]) >= 988) return { errorClass: "TRANSIENT", retryable: true }
  // Remaining NS_* and IMS_601 ("not all variables filled in") are our-side input
  // problems. Spec warns new NS_100–999 codes may appear without notice -> any
  // unrecognised NS_ code falls here (non-retryable, so we don't blindly re-bill).
  if (code.startsWith("NS_") || code === "IMS_601") return { errorClass: "INPUT", retryable: false }
  return { errorClass: "UNKNOWN", retryable: false }
}

export interface ExperianEnquiryInput {
  identityNumber: string
  identityType: "SID" | "PASSPORT"
  surname: string
  forename: string
  gender?: "M" | "F"
  dateOfBirth: Date | string // normalised to YYYY-MM-DD
  purpose: string // ENQUIRY_PURPOSE code, e.g. "12"
  clientConsent: "Y" | "N"
  valueAdd?: {
    bureauScore?: boolean
    deeds?: boolean
    directors?: boolean
    safps?: boolean
    pinpoints?: boolean
  }
  clientReference?: string // echoed back by Experian; wire to applicationId for audit
}

export interface ExperianValidationError {
  ok: false
  errorCode: string
  errorClass: ExperianErrorClass
  error: string
}

// South Africa is UTC+2 with no DST. The bureau is a SA service and the spec's
// RequestTime is a naive (no-TZ) timestamp, so age/minor checks and RequestTime
// must use the SA calendar — not UTC, which lags by 2h and would mis-date births
// and requests near midnight SAST.
const SAST_OFFSET_MS = 2 * 60 * 60 * 1000
function saParts(now: Date): { y: number; m: number; d: number } {
  const sa = new Date(now.getTime() + SAST_OFFSET_MS)
  return { y: sa.getUTCFullYear(), m: sa.getUTCMonth() + 1, d: sa.getUTCDate() }
}

/** SAST wall-clock as the spec's naive YYYY-MM-DDThh:mm:ss (spec section 5/6.1
 *  shows no timezone designator — do NOT append Z). */
export function formatRequestTime(now: Date): string {
  const sa = new Date(now.getTime() + SAST_OFFSET_MS)
  const p = (n: number) => String(n).padStart(2, "0")
  return `${sa.getUTCFullYear()}-${p(sa.getUTCMonth() + 1)}-${p(sa.getUTCDate())}T${p(sa.getUTCHours())}:${p(sa.getUTCMinutes())}:${p(sa.getUTCSeconds())}`
}

function toIsoDate(d: Date | string): string | null {
  if (d instanceof Date) return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d.trim())
  if (!m) return null
  const [, yy, mm, dd] = m
  // Reject impossible calendar dates (e.g. 2006-99-99, 2021-02-30) — the regex
  // alone would forward them to the bureau and corrupt the age arithmetic.
  const dt = new Date(`${yy}-${mm}-${dd}T00:00:00Z`)
  if (isNaN(dt.getTime()) || dt.getUTCMonth() + 1 !== Number(mm) || dt.getUTCDate() !== Number(dd)) return null
  return `${yy}-${mm}-${dd}`
}

function ageFromIsoDob(isoDob: string, now: Date): number {
  const [y, m, day] = isoDob.split("-").map(Number)
  const t = saParts(now)
  let age = t.y - y
  if (t.m < m || (t.m === m && t.d < day)) age--
  return age
}

type ValidationOk = { ok: true; isoDob: string }

/** Mirrors the NS_1xx/NS_2xx input rules so we reject bad/illegal enquiries
 *  BEFORE spending a billable call (and refuse to bill at all without consent). */
export function validateEnquiryInput(
  input: ExperianEnquiryInput,
  now: Date = new Date()
): ValidationOk | ExperianValidationError {
  const fail = (errorCode: string, error: string): ExperianValidationError => ({
    ok: false,
    errorCode,
    errorClass: classifyExperianError(errorCode).errorClass,
    error,
  })

  const required: Array<[string, string]> = [
    ["identityNumber", input.identityNumber],
    ["identityType", input.identityType],
    ["surname", input.surname],
    ["forename", input.forename],
    ["purpose", input.purpose],
    ["clientConsent", input.clientConsent],
  ]
  for (const [name, val] of required) {
    if (val == null || String(val).trim() === "") return fail("NS_210", `Missing required field: ${name}`)
  }

  if (input.identityType !== "SID" && input.identityType !== "PASSPORT")
    return fail("NS_108", "Identity Type can only be SID or PASSPORT")
  if (input.surname.length > 35) return fail("NS_109", "Surname length exceeds 35 characters")
  if (input.forename.length > 35) return fail("NS_110", "Forename length exceeds 35 characters")
  if (input.gender != null && input.gender !== "M" && input.gender !== "F")
    return fail("NS_111", "Gender can only be M or F")
  if (!VALID_PURPOSE_CODES.has(input.purpose)) return fail("NS_113", "Invalid Enquiry purpose supplied")
  if (input.clientConsent !== "Y" && input.clientConsent !== "N")
    return fail("NS_114", "Client Consent can only be Y or N")
  // Don't spend a billable enquiry without consent — Experian rejects N anyway (NS_208).
  if (input.clientConsent === "N") return fail("NS_208", "Client Consent was not given")

  const isoDob = toIsoDate(input.dateOfBirth)
  if (!isoDob) return fail("NS_200", "Date Of Birth malformed — expected YYYY-MM-DD")

  if (input.identityType === "SID") {
    const id = input.identityNumber.replace(/[\s-]/g, "")
    if (id.length !== 13 || !isValidSaIdChecksum(id)) return fail("NS_201", "Invalid SA ID number supplied")
    if (crossValidateSaIdWithDob(id, isoDob).mismatch)
      return fail("NS_202", "SA ID number portion and Date Of Birth does not match")
  } else if (input.identityNumber.length > 16) {
    // NS_107: the field-length table allows 16 but the error text says 13 —
    // confirm the real passport cap with Experian. We honour the field def (16).
    return fail("NS_107", "Identity Number length exceeds 16 characters")
  }

  if (ageFromIsoDob(isoDob, now) < 18) return fail("NS_209", "Date Of Birth qualifies as a minor")

  return { ok: true, isoDob }
}

const yn = (b?: boolean) => (b ? "Y" : "N")

/** REST request body `RequestNormalSearchV3Body` per the UAT Swagger (OpenAPI
 *  3.0.1, self-served 2026-06-24): snake_case keys, and `purpose` is an int32 —
 *  NOT the camelCase/string shape the SOAP example suggested. Field shapes
 *  verified against the spec; live response still pending test consumer IDs. */
export function buildRequestPayload(
  input: ExperianEnquiryInput,
  isoDob: string,
  envLabel: string,
  requestTime: string
) {
  return {
    system_settings: {
      version: "1.0",
      originating_application: process.env.EXPERIAN_ORIGINATING_APP ?? "lms",
      originating_environment: envLabel,
      client_reference: input.clientReference ?? "",
      request_time: requestTime,
    },
    search_criteria: {
      identity_number: input.identityNumber,
      identity_type: input.identityType,
      surname: input.surname,
      forename: input.forename,
      ...(input.gender ? { gender: input.gender } : {}),
      date_of_birth: isoDob,
      purpose: Number(input.purpose), // schema: integer int32 (validated as a 1–19 code string)
      client_consent: input.clientConsent,
      value_add_services: {
        want_bureau_score: yn(input.valueAdd?.bureauScore),
        want_deeds: yn(input.valueAdd?.deeds),
        want_directors: yn(input.valueAdd?.directors),
        want_safps: yn(input.valueAdd?.safps),
        want_pinpoints: yn(input.valueAdd?.pinpoints),
      },
    },
  }
}
