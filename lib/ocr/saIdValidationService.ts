/**
 * SA ID Validation Service
 *
 * Handles South African ID number validation and cross-validation with DOB.
 * SA ID format: YYMMDD SSSS C A Z (13 digits total)
 * - First 6 digits = Date of Birth (YYMMDD)
 * - Digits 7-10 = Sequence number
 * - Digit 11 = Citizenship (0=SA, 1=Permanent resident)
 * - Digit 12 = Race digit (legacy, usually 8)
 * - Digit 13 = Luhn checksum digit
 */

export interface IdCrossValidationResult {
  mismatch: boolean;
  corrected: boolean;
  correctedId?: string;
  reason: string;
}

/**
 * Validate SA ID number using Luhn algorithm (mod 10 checksum).
 * The last digit of SA ID is a check digit.
 */
export function isValidSaIdChecksum(idNumber: string): boolean {
  if (idNumber.length !== 13 || !/^\d+$/.test(idNumber)) {
    return false;
  }

  let sum = 0;
  for (let i = 0; i < 12; i++) {
    let digit = parseInt(idNumber.charAt(i), 10);

    // Double every second digit (from right, so odd positions from left in 0-indexed)
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) {
        digit -= 9;
      }
    }

    sum += digit;
  }

  // Check digit should make total divisible by 10
  const checkDigit = (10 - (sum % 10)) % 10;
  return checkDigit === parseInt(idNumber.charAt(12), 10);
}

/**
 * Cross-validate SA ID number against date of birth.
 *
 * The DOB from a separate field extraction is often more reliable than OCR
 * of the ID number itself, because DOB is typically printed in larger, clearer text.
 * When there is a mismatch, attempt to auto-correct by replacing the DOB prefix
 * in the ID number and verifying the Luhn checksum holds.
 */
export function crossValidateSaIdWithDob(
  idNumber: string,
  dateOfBirth: string
): IdCrossValidationResult {
  // Clean the ID number (remove spaces/dashes)
  const cleanId = (idNumber || '').replace(/[\s\-]/g, '');

  // Parse DOB (expected format: YYYY-MM-DD)
  const dobMatch = (dateOfBirth || '').match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!dobMatch || !dobMatch[1] || !dobMatch[2] || !dobMatch[3]) {
    return { mismatch: false, corrected: false, reason: 'DOB format not recognized' };
  }

  const year = dobMatch[1];
  const month = dobMatch[2];
  const day = dobMatch[3];
  const yy = year.slice(-2); // Last 2 digits of year
  const expectedDobPrefix = `${yy}${month}${day}`; // YYMMDD

  // Check if ID number has exactly 13 digits
  if (cleanId.length !== 13) {
    return {
      mismatch: false,
      corrected: false,
      reason: `ID number length is ${cleanId.length}, expected 13`,
    };
  }

  const idDobPrefix = cleanId.substring(0, 6);

  // If prefixes match, no correction needed
  if (idDobPrefix === expectedDobPrefix) {
    return { mismatch: false, corrected: false, reason: 'ID and DOB match correctly' };
  }

  // Mismatch detected — try to correct the ID based on DOB
  const correctedId = expectedDobPrefix + cleanId.substring(6);

  // Validate the corrected ID passes Luhn check
  if (isValidSaIdChecksum(correctedId)) {
    return {
      mismatch: true,
      corrected: true,
      correctedId,
      reason: `ID DOB prefix "${idDobPrefix}" corrected to "${expectedDobPrefix}" based on extracted DOB (${dateOfBirth}). Checksum valid.`,
    };
  }

  // Corrected ID fails checksum — flag the mismatch but do not auto-correct
  return {
    mismatch: true,
    corrected: false,
    reason: `ID DOB prefix "${idDobPrefix}" doesn't match extracted DOB "${expectedDobPrefix}" (${dateOfBirth}). Auto-correction failed checksum validation.`,
  };
}
