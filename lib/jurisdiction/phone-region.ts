/**
 * Lesotho phone numbers and districts, for client capture.
 *
 * Numbers: country code 266 and eight digits. Mobiles start 5 (Vodacom
 * Lesotho) or 6 (Econet Telecom Lesotho); landlines start 2. Only mobiles are
 * accepted because the wizard's phone is the SMS/WhatsApp contact. If the
 * regulator allocates a new mobile prefix, add it here.
 */
const MOBILE_LOCAL = /^[56]\d{7}$/
const MOBILE_E164 = /^\+266[56]\d{7}$/

export function isValidLesothoMobile(raw: string): boolean {
  const value = raw.replace(/ /g, "")
  return MOBILE_E164.test(value) || MOBILE_LOCAL.test(value)
}

/** The ten districts, as two-letter codes stored in the address `province` field. */
export const LESOTHO_DISTRICTS = ["BE", "BB", "LE", "MF", "MS", "MH", "MK", "QN", "QT", "TT"] as const

export const LESOTHO_DISTRICT_NAMES: Record<(typeof LESOTHO_DISTRICTS)[number], string> = {
  BE: "Berea",
  BB: "Butha-Buthe",
  LE: "Leribe",
  MF: "Mafeteng",
  MS: "Maseru",
  MH: "Mohale's Hoek",
  MK: "Mokhotlong",
  QN: "Qacha's Nek",
  QT: "Quthing",
  TT: "Thaba-Tseka",
}
