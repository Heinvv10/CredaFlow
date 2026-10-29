/**
 * Lesotho national identity number.
 *
 * UNCONFIRMED: no public specification of the national ID card number was
 * found, so nothing here claims a checksum, a date-of-birth prefix or a
 * fixed length. Validation is SHAPE ONLY: 6 to 15 letters or digits. That
 * refuses blanks, punctuation and obvious typos without rejecting a real
 * number whose layout this code does not know. A Lesotho lender therefore
 * keys date of birth and gender by hand (nothing is derived from the number),
 * and a typo in the number is NOT caught here.
 *
 * To tighten: get the layout from the Ministry of Home Affairs (National
 * Identity and Civil Registry) or the lender, then change LESOTHO_ID_SHAPE
 * and flip LESOTHO_ID_SHAPE_ONLY.
 */
export const LESOTHO_ID_SHAPE_ONLY = true

const LESOTHO_ID_SHAPE = /^[A-Z0-9]{6,15}$/

export function isValidLesothoNationalId(raw: string): boolean {
  return LESOTHO_ID_SHAPE.test(raw.trim().toUpperCase())
}
