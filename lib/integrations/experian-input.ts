import { type ExperianEnquiryInput, ENQUIRY_PURPOSE } from "@/lib/integrations/experian"

/** Derive YYYY-MM-DD from a SA ID's YYMMDD prefix, choosing the century that
 *  yields a plausible adult (18–100). The bureau matches primarily on the ID;
 *  we send a DOB whose YYMMDD matches the ID so our own NS_202 cross-check
 *  (and the bureau's) passes. Returns null if the prefix is not a valid date. */
export function deriveDobFromSaId(idNumber: string): string | null {
  const id = idNumber.replace(/[\s-]/g, "")
  if (id.length !== 13 || !/^\d+$/.test(id)) return null
  const yy = Number(id.slice(0, 2)), mm = Number(id.slice(2, 4)), dd = Number(id.slice(4, 6))
  const nowYear = new Date().getUTCFullYear()
  for (const cent of [1900, 2000]) {
    const y = cent + yy
    const dt = new Date(Date.UTC(y, mm - 1, dd))
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() + 1 !== mm || dt.getUTCDate() !== dd) continue
    const age = nowYear - y
    if (age >= 18 && age <= 100) {
      return `${y}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`
    }
  }
  return null
}

function isoOrNull(d: Date): string | null {
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

export function buildExperianEnquiryInput(args: {
  idNumber: string
  firstName: string
  lastName: string
  gender?: "M" | "F" | null
  dateOfBirth?: Date | null
  consentGranted: boolean
  applicationId: string
}): ExperianEnquiryInput {
  const derived = deriveDobFromSaId(args.idNumber)
  const clientIso = args.dateOfBirth ? isoOrNull(args.dateOfBirth) : null
  // Use the client DOB only when its YYMMDD matches the ID prefix; else derive.
  const idPrefix = args.idNumber.replace(/[\s-]/g, "").slice(0, 6)
  const clientPrefix = clientIso ? clientIso.slice(2, 4) + clientIso.slice(5, 7) + clientIso.slice(8, 10) : null
  const dateOfBirth = clientIso && clientPrefix === idPrefix ? clientIso : (derived ?? clientIso ?? "")
  return {
    identityNumber: args.idNumber,
    identityType: "SID",
    surname: args.lastName,
    forename: args.firstName,
    ...(args.gender ? { gender: args.gender } : {}),
    dateOfBirth,
    purpose: ENQUIRY_PURPOSE.AFFORDABILITY_ASSESSMENT, // "11"
    clientConsent: args.consentGranted ? "Y" : "N",
    valueAdd: { bureauScore: true },
    clientReference: args.applicationId,
  }
}
