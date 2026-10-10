/**
 * Synthetic South African ID numbers.
 *
 * Layout: YYMMDD SSSS C A Z — date of birth, gender sequence (0000–4999 female,
 * 5000–9999 male), citizenship (0 = citizen), the legacy "A" digit (8), and a
 * Luhn check digit. The app validates exactly this (lib/ocr/saIdValidationService.ts,
 * lib/validation/client-wizard.ts).
 *
 * SYNTHETIC PATTERN: the sequence digits are the persona's index offset from
 * the gender base (female 0001…, male 5001…). Real sequences are allocated by
 * Home Affairs; a run of personas whose sequences are 0001, 0002, 5003 … is an
 * obviously manufactured set. It cannot guarantee no real person holds one of
 * these numbers — any Luhn-valid number might — which is why every document
 * carrying one is watermarked SPECIMEN.
 */

/** Luhn check digit for the first 12 digits of an SA ID. */
export function saIdCheckDigit(first12: string): number {
  if (!/^\d{12}$/.test(first12)) throw new Error(`expected 12 digits, got "${first12}"`)
  let sum = 0
  for (let i = 0; i < 12; i++) {
    let d = Number(first12[i])
    // Doubling every second digit counted from the check digit leftwards,
    // i.e. the odd 0-based positions of a 13-digit number.
    if (i % 2 === 1) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
  }
  return (10 - (sum % 10)) % 10
}

export function buildSaIdNumber(args: {
  dateOfBirth: string
  gender: 'MALE' | 'FEMALE'
  index: number
}): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(args.dateOfBirth)
  if (!m) throw new Error(`dateOfBirth must be YYYY-MM-DD, got "${args.dateOfBirth}"`)
  if (args.index < 1 || args.index > 4999) throw new Error(`index out of range: ${args.index}`)
  const yymmdd = `${m[1]!.slice(2)}${m[2]}${m[3]}`
  const sequence = String((args.gender === 'MALE' ? 5000 : 0) + args.index).padStart(4, '0')
  const first12 = `${yymmdd}${sequence}08`
  return `${first12}${saIdCheckDigit(first12)}`
}
