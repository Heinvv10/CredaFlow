import { describe, it, expect } from "vitest"
import {
  validateEnquiryInput,
  classifyExperianError,
  buildRequestPayload,
  formatRequestTime,
  getCreditReport,
  parseEnquiryResult,
  ENQUIRY_PURPOSE,
  SIGMA_SCORE_MIN,
  SIGMA_SCORE_MAX,
  type ExperianEnquiryInput,
} from "./experian"

// Valid SA ID with DoB 1990-01-01, male (Luhn-checked against saIdValidationService).
const VALID_SA_ID = "9001015009086"
const NOW = new Date("2026-06-22T00:00:00Z")

function base(overrides: Partial<ExperianEnquiryInput> = {}): ExperianEnquiryInput {
  return {
    identityNumber: VALID_SA_ID,
    identityType: "SID",
    surname: "Mokoena",
    forename: "Thabo",
    gender: "M",
    dateOfBirth: "1990-01-01",
    purpose: ENQUIRY_PURPOSE.AFFORDABILITY_ASSESSMENT,
    clientConsent: "Y",
    ...overrides,
  }
}

describe("validateEnquiryInput", () => {
  it("accepts a valid SID enquiry and returns the normalised DoB", () => {
    const r = validateEnquiryInput(base(), NOW)
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.isoDob).toBe("1990-01-01")
  })

  it("rejects missing required fields with NS_210", () => {
    const r = validateEnquiryInput(base({ surname: "  " }), NOW)
    expect(r).toMatchObject({ ok: false, errorCode: "NS_210", errorClass: "INPUT" })
  })

  it("rejects an unknown identity type with NS_108", () => {
    const r = validateEnquiryInput(base({ identityType: "FOO" as unknown as "SID" }), NOW)
    expect(r).toMatchObject({ ok: false, errorCode: "NS_108" })
  })

  it("rejects an invalid SA ID checksum with NS_201", () => {
    const r = validateEnquiryInput(base({ identityNumber: "9001015009087" }), NOW)
    expect(r).toMatchObject({ ok: false, errorCode: "NS_201", errorClass: "DATA_QUALITY" })
  })

  it("rejects an ID/DoB mismatch with NS_202", () => {
    const r = validateEnquiryInput(base({ dateOfBirth: "1991-01-01" }), NOW)
    expect(r).toMatchObject({ ok: false, errorCode: "NS_202", errorClass: "DATA_QUALITY" })
  })

  it("rejects a minor with NS_209", () => {
    // PASSPORT skips SA-ID validation, isolating the minor check.
    const r = validateEnquiryInput(
      base({ identityType: "PASSPORT", identityNumber: "A1234567", dateOfBirth: "2015-01-01" }),
      NOW
    )
    expect(r).toMatchObject({ ok: false, errorCode: "NS_209", errorClass: "DATA_QUALITY" })
  })

  it("refuses to bill when consent is N (NS_208) before any network call", () => {
    const r = validateEnquiryInput(base({ clientConsent: "N" }), NOW)
    expect(r).toMatchObject({ ok: false, errorCode: "NS_208", errorClass: "CONSENT" })
  })

  it("rejects an invalid gender with NS_111", () => {
    const r = validateEnquiryInput(base({ gender: "X" as unknown as "M" }), NOW)
    expect(r).toMatchObject({ ok: false, errorCode: "NS_111" })
  })

  it("rejects an invalid purpose code with NS_113", () => {
    const r = validateEnquiryInput(base({ purpose: "99" }), NOW)
    expect(r).toMatchObject({ ok: false, errorCode: "NS_113" })
  })

  it("rejects an impossible calendar date with NS_200", () => {
    const r = validateEnquiryInput(base({ identityType: "PASSPORT", identityNumber: "A1234567", dateOfBirth: "2006-99-99" }), NOW)
    expect(r).toMatchObject({ ok: false, errorCode: "NS_200" })
  })

  it("accepts someone exactly 18 today but rejects them the day before (SAST boundary)", () => {
    const turns18Today = validateEnquiryInput(
      base({ identityType: "PASSPORT", identityNumber: "A1234567", dateOfBirth: "2008-06-22" }),
      NOW
    )
    expect(turns18Today.ok).toBe(true)
    const turns18Tomorrow = validateEnquiryInput(
      base({ identityType: "PASSPORT", identityNumber: "A1234567", dateOfBirth: "2008-06-23" }),
      NOW
    )
    expect(turns18Tomorrow).toMatchObject({ ok: false, errorCode: "NS_209" })
  })

  it("accepts a passport without SA-ID validation", () => {
    const r = validateEnquiryInput(base({ identityType: "PASSPORT", identityNumber: "A1234567" }), NOW)
    expect(r.ok).toBe(true)
  })
})

describe("parseEnquiryResult", () => {
  it("maps a successful BureauResponse: SigmaScore, adverse notes, debt review", () => {
    const r = parseEnquiryResult({
      response_status: "Success",
      return_data: {
        bureau_scores: [
          { score_type: "Generic", score: 800 },
          { score_type: "SS", risk_type: "AVERAGE RISK", score: 612, version: 4.0 },
        ],
        adverses: [{ adverse_code_desc: "Account handed over" }, { adverse_code_desc: "" }],
        debt_restructurings: [{ application_date: "2025-01-01" }],
      },
    })
    expect(r).toMatchObject({ ok: true, score: 612, riskGrade: "AVERAGE RISK", underDebtReview: true })
    expect(r.adverseInfo).toEqual(["Account handed over"])
  })

  it("ignores non-SS score types and picks the latest-version SS entry", () => {
    const r = parseEnquiryResult({
      response_status: "Success",
      return_data: {
        bureau_scores: [
          { score_type: "Generic", score: 999 },
          { score_type: "SS", risk_type: "LOW RISK", score: 540, version: 4.0 },
          { score_type: "SS", risk_type: "LOW RISK", score: 700, version: 4.01 },
        ],
      },
    })
    expect(r).toMatchObject({ ok: true, score: 700 })
  })

  it("treats response_status Failure (HTTP 200) as an error", () => {
    const r = parseEnquiryResult({ response_status: "Failure", error_code: "NS_208", error_description: "Client Consent was not given" })
    expect(r).toMatchObject({ ok: false, errorCode: "NS_208", errorClass: "CONSENT" })
  })

  it("fails closed (UNKNOWN, non-retryable) on a Failure with no error code", () => {
    const r = parseEnquiryResult({ response_status: "Failure" })
    expect(r).toMatchObject({ ok: false, errorClass: "UNKNOWN", retryable: false })
  })

  it("fails closed on a missing response_status — never a false-positive success", () => {
    const r = parseEnquiryResult({})
    expect(r).toMatchObject({ ok: false, errorCode: "EXPERIAN_NO_STATUS", errorClass: "UNKNOWN", retryable: false })
  })

  it("returns ok with no score when Success carries an empty return_data", () => {
    const r = parseEnquiryResult({ response_status: "Success" })
    expect(r).toMatchObject({ ok: true, score: null, unscoreable: true, underDebtReview: false })
    expect(r.adverseInfo).toEqual([])
  })

  it("returns unscoreable (not a numeric score) when the SS entry is a sentinel below the band floor", () => {
    const r = parseEnquiryResult({
      response_status: "Success",
      return_data: { bureau_scores: [{ score_type: "SS", score: -1, version: 4.0 }] },
    })
    expect(r.score).toBeNull()
    expect(r.unscoreable).toBe(true)
  })
})

describe("formatRequestTime", () => {
  it("emits SAST (UTC+2) wall-clock with no timezone designator", () => {
    expect(formatRequestTime(new Date("2026-06-22T08:00:00Z"))).toBe("2026-06-22T10:00:00")
  })
})

describe("classifyExperianError", () => {
  it("treats branch/auth errors as CONFIG, non-retryable", () => {
    expect(classifyExperianError("IMS_608")).toEqual({ errorClass: "CONFIG", retryable: false })
    expect(classifyExperianError("NS_205")).toEqual({ errorClass: "CONFIG", retryable: false })
  })

  it("treats internal NS_988+ errors as TRANSIENT, retryable", () => {
    expect(classifyExperianError("NS_995")).toEqual({ errorClass: "TRANSIENT", retryable: true })
  })

  it("treats consent and data-quality codes distinctly", () => {
    expect(classifyExperianError("NS_208").errorClass).toBe("CONSENT")
    expect(classifyExperianError("NS_202").errorClass).toBe("DATA_QUALITY")
  })

  it("fails closed on unrecognised codes", () => {
    expect(classifyExperianError("WAT_1")).toEqual({ errorClass: "UNKNOWN", retryable: false })
  })
})

describe("buildRequestPayload", () => {
  it("maps fields to the Swagger snake_case structure with an integer purpose", () => {
    const p = buildRequestPayload(base({ valueAdd: { bureauScore: true, safps: true } }), "1990-01-01", "UAT", "2026-06-22T08:00:00")
    expect(p.system_settings).toMatchObject({ version: "1.0", originating_environment: "UAT" })
    expect(p.search_criteria).toMatchObject({ client_consent: "Y", date_of_birth: "1990-01-01" })
    expect(p.search_criteria.purpose).toBe(11) // integer, not "11"
    expect(p.search_criteria.value_add_services).toMatchObject({ want_bureau_score: "Y", want_safps: "Y", want_deeds: "N" })
  })

  it("omits gender when not supplied", () => {
    const p = buildRequestPayload(base({ gender: undefined }), "1990-01-01", "UAT", "2026-06-22T08:00:00")
    expect("gender" in p.search_criteria).toBe(false)
  })
})

describe("getCreditReport (dry-run under NODE_ENV=test)", () => {
  it("returns an in-band SigmaScore for valid input", async () => {
    const r = await getCreditReport(base())
    expect(r.ok).toBe(true)
    expect(r.score).toBeGreaterThanOrEqual(SIGMA_SCORE_MIN)
    expect(r.score).toBeLessThanOrEqual(SIGMA_SCORE_MAX)
    expect(r).toMatchObject({
      totalMonthlyObligations: 0,
      accounts: [],
      obligationRows: [],
    })
  })

  it("short-circuits invalid input without hitting the network", async () => {
    const r = await getCreditReport(base({ clientConsent: "N" }))
    expect(r).toMatchObject({ ok: false, errorCode: "NS_208", errorClass: "CONSENT" })
  })
})
