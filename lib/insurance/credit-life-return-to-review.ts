import {
  CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
  creditLifeOfferedFor,
  type CreditLifeOffer,
} from "./credit-life-election"
import {
  verifyStoredCreditLifeDisclosure,
  type StoredCreditLifeDisclosure,
} from "./credit-life-election.server"

export type CreditLifeRetentionDecision =
  | { retain: true }
  | { retain: false; reason: "unverifiable" | "offer_now_available" | "offer_changed" }

/**
 * Whether a stored credit-life election is still exactly true after an approved
 * application is returned to review.
 *
 * Returning to review withdraws the approval, the PASQ and the agreement — but
 * it does not touch `appliedAmount` or `appliedTermDays`, and those (with the
 * offer identity and the derived premium) are the whole of what the disclosure
 * hash binds. So the election only goes stale when the OFFER moved underneath
 * it, never because the approval was withdrawn.
 *
 * Clearing it unconditionally is what made a one-field correction expensive:
 * the only surface that can recapture an election is the draft wizard, and
 * reaching it also discards the bureau enquiry, so the consumer pays for a
 * second bureau footprint to re-record byte-identical evidence.
 *
 * RETENTION HAS NO TIME BOUND, and that is a decision, not an oversight.
 * An election is retained on
 * integrity alone — whether it still verifies against current state — with no
 * expiry on how long ago the consumer acknowledged it.
 *
 * The reasoning: nothing a credit-life election asserts is a quoted price that
 * decays. The premium is R4.50 per R1,000 per month from Credit Life
 * Regulations, 2017 reg 3(1) — a statutory constant derived from the principal
 * (credit-life-election.ts), not a rate anyone quoted — and the offer identity
 * is re-checked against the current offer on every branch below. So there is no
 * stale figure hiding inside a verifying election.
 *
 * The argument this does NOT answer is consent freshness: an election made
 * months ago can bind an agreement signed today. That is a policy question
 * rather than a correctness one, and it was decided deliberately. Revisit it if
 * legal sets a validity period for consumer credit-life elections; the natural
 * bound would be `quotationValidUntilDateFromDatabase` (5 business days), which
 * is what the pre-agreement quotation already uses.
 *
 * The no-offer branch answers the same question as
 * `guardLoanApplicationCreditLifeOffer` in
 * the baseline migration, which re-checks the
 * no-offer assertion when the row next enters APPROVED — keeping evidence here
 * that the trigger rejects there would only move the failure to a staff member
 * who has no way to act on it.
 *
 * The two predicates are NOT identical, and the difference matters: the trigger
 * is an unordered EXISTS over every non-blank-named active product, while the
 * offer reaching this function comes from an ORDERED findFirst returning one
 * row. They agree once blank names are excluded from that query, but Prisma
 * cannot express BTRIM, so a whitespace-only name can still resolve to `null`
 * here while the trigger finds a usable product. The caller closes that gap by
 * failing closed — a product row that exists but cannot be presented clears
 * rather than retains. Do not restate this as a mirror; it is a one-way
 * conservative approximation.
 */
export function creditLifeEvidenceSurvivesReturnToReview(
  stored: StoredCreditLifeDisclosure,
  terms: { principalCents: number; termDays: number },
  currentOffer: CreditLifeOffer | null,
): CreditLifeRetentionDecision {
  const verified = verifyStoredCreditLifeDisclosure(stored, terms)
  if (!verified.ok) return { retain: false, reason: "unverifiable" }

  if (verified.evidence.version === CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION) {
    // The row asserts no cover was offered. An insurer onboarded since makes
    // that assertion false, so the consumer has to be asked against the offer
    // that now exists.
    // At or below the threshold a configured product is no offer (B6), so the
    // assertion stays true.
    return !creditLifeOfferedFor(currentOffer !== null, terms.principalCents)
      ? { retain: true }
      : { retain: false, reason: "offer_now_available" }
  }

  if (currentOffer === null) return { retain: false, reason: "offer_changed" }

  const sameOffer =
    verified.evidence.productId === currentOffer.productId
    && verified.evidence.productName === currentOffer.productName
    && verified.evidence.insurerId === currentOffer.insurerId
    && verified.evidence.insurerName === currentOffer.insurerName
  return sameOffer ? { retain: true } : { retain: false, reason: "offer_changed" }
}
