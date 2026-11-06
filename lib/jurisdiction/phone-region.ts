import { activeJurisdiction } from "./active"
import { profileFor, type Jurisdiction } from "./profiles"

/**
 * Lesotho phone numbers, for client capture.
 *
 * Numbers: country code 266 and eight digits. Mobiles start 5 (Vodacom
 * Lesotho) or 6 (Econet Telecom Lesotho); landlines start 2. Only mobiles are
 * accepted because the wizard's phone is the SMS/WhatsApp contact. If the
 * regulator allocates a new mobile prefix, change it in profiles.ts. The ten
 * districts are in the same file.
 */
export function isValidLesothoMobile(raw: string): boolean {
  const value = raw.replace(/ /g, "")
  return profileFor("LS").capture.mobilePatterns.some((pattern) => pattern.test(value))
}

/**
 * Kenyan phone numbers, for client capture.
 *
 * Numbers: country code 254 and nine digits, written locally with a trunk 0.
 * Mobiles start 7 or 10/11 (Safaricom, Airtel, Telkom); landlines (020
 * Nairobi and the other area codes) are refused, as for Lesotho. The prefix
 * list is UNVERIFIED against the Communications Authority's numbering plan;
 * change it in profiles.ts. The 47 counties are in the same file.
 */
export function isValidKenyaMobile(raw: string): boolean {
  const value = raw.replace(/ /g, "")
  return profileFor("KE").capture.mobilePatterns.some((pattern) => pattern.test(value))
}

/**
 * The country code a ten-digit local number written with the trunk 0
 * ("0821234567", "0712345678") takes: the lender's own. Lesotho has no trunk
 * prefix, so there such a number is South African, as it always was.
 */
export function trunkZeroDialCode(jurisdiction: Jurisdiction = activeJurisdiction()): string {
  const capture = profileFor(jurisdiction).capture
  return capture.localTrunkZero ? capture.dialCode : profileFor("ZA").capture.dialCode
}
