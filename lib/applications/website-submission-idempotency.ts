import { createHash } from "node:crypto"

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

function number(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Validate a browser-generated request idempotency key.
 *
 * The field remains optional so a cached copy of the pre-idempotency website
 * bundle can still submit while a release rolls out. New clients always send a
 * cryptographically random UUID.
 */
export function parseWebsiteSubmissionKey(value: unknown): string | null {
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new Error("INVALID_WEBSITE_SUBMISSION_KEY")
  const key = value.trim()
  if (!UUID_PATTERN.test(key)) throw new Error("INVALID_WEBSITE_SUBMISSION_KEY")
  return key.toLowerCase()
}

/**
 * Bind an idempotency key to the material application payload. Turnstile is
 * deliberately excluded because a retry can require a fresh challenge token.
 */
export function fingerprintWebsiteSubmission(body: Record<string, unknown>): string {
  const canonical = {
    firstName: text(body.firstName),
    lastName: text(body.lastName),
    email: text(body.email).toLowerCase(),
    phone: text(body.phone),
    idNumber: text(body.idNumber),
    employmentStatus: text(body.employmentStatus).toUpperCase(),
    employerName: text(body.employerName),
    monthlyIncome: number(body.monthlyIncome),
    monthlyExpenses: number(body.monthlyExpenses),
    productType: text(body.productType).toUpperCase(),
    amount: number(body.amount),
    termDays: number(body.termDays),
    purpose: text(body.purpose),
    popiaConsent: body.popiaConsent === true,
    source: text(body.source).toUpperCase(),
    referralCode: text(body.referralCode),
    utmSource: text(body.utmSource),
    utmMedium: text(body.utmMedium),
    utmCampaign: text(body.utmCampaign),
  }

  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex")
}
