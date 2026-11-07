import { profileFor } from "@/lib/jurisdiction/profiles"
import { isValidKenyaNationalId, isValidLesothoNationalId } from "@/lib/jurisdiction/national-id"
import type { SiteJurisdiction } from "@/lib/website/site-jurisdiction"

/** The 13-digit South African ID with its check digit. */
function validateSAId(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) {
    const digit = parseInt(id[i])
    if (i % 2 === 0) sum += digit
    else {
      const doubled = digit * 2
      sum += doubled > 9 ? doubled - 9 : doubled
    }
  }
  return (10 - (sum % 10)) % 10 === parseInt(id[12])
}

/**
 * The error for the apply form's ID field, or null when the ID is acceptable.
 * A South African lender keeps its catalogue message (`saMessage`); any other
 * lender's ID is judged by its own jurisdiction's check, with that profile's message.
 */
export function applyIdError(site: SiteJurisdiction, id: string, saMessage: string): string | null {
  if (site.nca) return validateSAId(id) ? null : saMessage
  const { idScheme, idInvalid } = profileFor(site.code).capture
  const valid = idScheme === "KE_ID" ? isValidKenyaNationalId(id) : idScheme === "LS_ID" ? isValidLesothoNationalId(id) : false
  return valid ? null : idInvalid
}
