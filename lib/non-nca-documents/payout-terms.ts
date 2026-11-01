import { sastCalendarDate } from "@/lib/date/sast"

/** What the payout channel is, and is not, for a key-facts loan: shown with every disbursement. */
export const KEY_FACTS_PAYOUT_NOTE =
  "Manual payout: no money moves in the system. Make the bank transfer only once every payout check has passed, then record its reference. An automated rail needs the core banking adapter (tender 2.5.1)."

/** AvsCheck.provider of a second person's confirmation (payout-account.ts). */
export const SECOND_PERSON_VERIFICATION_PROVIDER = "second_person"

export const KEY_FACTS_BANK_REF_MAX = 64
export const PAYOUT_VERIFICATION_NOTE_MIN = 20
export const PAYOUT_VERIFICATION_NOTE_MAX = 500

/** The text a person can see: without control and format characters (a zero-width space is one) and without white space. */
const visible = (text: string) => text.replace(/[\p{Cc}\p{Cf}\s]/gu, "")

/**
 * The bank's reference for a manual transfer in the one form it is stored and held unique in, or null unless it is 1 to 64 characters on a
 * single line with a letter or digit in it and nothing invisible. Width (NFKC) and white space do not make a different reference, so
 * "TX-777  A" and "TX-777 A" are one transfer; punctuation does ("TX-777" and "TX777" are two). The index folds case.
 */
export function manualBankRef(value: unknown): string | null {
  if (typeof value !== "string") return null
  const folded = value.normalize("NFKC").trim()
  if (/[\p{Cc}\p{Cf}]/u.test(folded)) return null
  const ref = folded.replace(/\s/gu, "")
  return ref.length <= KEY_FACTS_BANK_REF_MAX && /[\p{L}\p{N}]/u.test(ref) ? ref : null
}

/** How the second person confirmed the account, trimmed, or null when it is too short to say or over the limit. */
export function payoutVerificationNote(value: unknown): string | null {
  if (typeof value !== "string") return null
  const note = value.trim()
  return visible(note).length >= PAYOUT_VERIFICATION_NOTE_MIN && note.length <= PAYOUT_VERIFICATION_NOTE_MAX ? note : null
}

/**
 * Whether an agreement can still be paid out at `at`. The schedule a key-facts agreement prints starts on the day of its approval and the
 * loan is booked on exactly that schedule, so a later payout would charge the printed interest for days the borrower did not have the
 * money. The signed agreement is therefore valid for payout on its start date (SAST) and no other; after it, staff return the
 * application to review, approve it again, and the borrower signs a new agreement.
 */
export function agreementPayableOn(startDate: Date, at: Date): boolean {
  return sastCalendarDate(startDate) === sastCalendarDate(at)
}
