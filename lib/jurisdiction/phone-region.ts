import { profileFor } from "./profiles"

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
