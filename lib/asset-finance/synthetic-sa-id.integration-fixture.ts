/**
 * A synthetic South African ID number for the integration fixtures, with a
 * valid Luhn check digit (scripts/demo/personas/sa-id.ts saIdCheckDigit, the
 * rule lib/ocr/saIdValidationService.ts validates). Client.idNumber is unique
 * across the whole database, so a fixed number makes two suites collide when
 * they run in parallel, and a crashed run's leftover rows break the next one.
 * The date of birth (1950-1999) and the sequence are random, so a number is
 * unique to its run in practice (1 in ~180 million per pair). Citizenship 0,
 * the legacy digit 8. Not a test file.
 */
import { randomInt } from "node:crypto"
import { saIdCheckDigit } from "@/scripts/demo/personas/sa-id"

const DAY_MS = 86_400_000
const BIRTH_DAYS = 18_262 // 1950-01-01 .. 1999-12-31

export function syntheticSaIdNumber(): string {
  const birth = new Date(Date.UTC(1950, 0, 1) + randomInt(0, BIRTH_DAYS) * DAY_MS).toISOString()
  const first12 = `${birth.slice(2, 4)}${birth.slice(5, 7)}${birth.slice(8, 10)}${String(randomInt(0, 10_000)).padStart(4, "0")}08`
  return `${first12}${saIdCheckDigit(first12)}`
}
