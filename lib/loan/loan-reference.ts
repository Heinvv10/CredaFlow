import { generateReference } from "@/lib/utils"

const ATTEMPTS = 5

/**
 * A new `LN-XXXXXXXX-XXXX` loan reference no loan or prepared mandate already
 * uses. The reference is unique (Loan.reference, the mandate's partial unique
 * index) and a signed mandate's reference becomes the loan's at payout, where
 * it can no longer change: a clash must be caught where it is minted, not at
 * disbursement. `isTaken` reads in the caller's transaction; the unique
 * indexes stay the backstop for a concurrent writer.
 */
export async function unusedLoanReference(isTaken: (reference: string) => Promise<boolean>): Promise<string> {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const reference = generateReference("LN")
    if (!(await isTaken(reference))) return reference
  }
  throw new Error(`No unused loan reference after ${ATTEMPTS} attempts`)
}
