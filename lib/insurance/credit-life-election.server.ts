import { createHash } from "node:crypto"
import type {
  CreditLifeDisclosureEvidence,
  CreditLifeNoOfferDisclosureEvidence,
} from "./credit-life-election"
import {
  CREDIT_LIFE_DISCLOSURE_VERSION,
  CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
  calculateCreditLifeMonthlyPremiumCents,
  isCreditLifeElection,
} from "./credit-life-election"

export function createCreditLifeDisclosureSha256(
  evidence: Omit<CreditLifeDisclosureEvidence, "acknowledgedAt" | "acknowledgedBy">,
): string {
  const canonical = JSON.stringify({
    version: evidence.version,
    election: evidence.election,
    principalCents: evidence.principalCents,
    termDays: evidence.termDays,
    monthlyPremiumCents: evidence.monthlyPremiumCents,
    productId: evidence.productId,
    productName: evidence.productName,
    insurerId: evidence.insurerId,
    insurerName: evidence.insurerName,
  })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

/**
 * Mirrored by "creditLifeNoOfferDisclosureSha256" in
 * the baseline migration. Keep the key order and
 * the JSON encoding identical or the DB guards reject every no-offer PASQ.
 */
export function createCreditLifeNoOfferDisclosureSha256(
  evidence: CreditLifeNoOfferDisclosureEvidence,
): string {
  const canonical = JSON.stringify({
    version: evidence.version,
    election: evidence.election,
    principalCents: evidence.principalCents,
    termDays: evidence.termDays,
  })
  return createHash("sha256").update(canonical, "utf8").digest("hex")
}

export interface StoredCreditLifeDisclosure {
  creditLifeElection: unknown
  creditLifeProductId: unknown
  creditLifeProductName: unknown
  creditLifeInsurerId: unknown
  creditLifeInsurerName: unknown
  creditLifeMonthlyPremiumCents: unknown
  creditLifeDisclosureVersion: unknown
  creditLifeDisclosureSha256: unknown
  creditLifeDisclosureAcknowledgedAt: unknown
  creditLifeDisclosureAcknowledgedBy: unknown
}

/**
 * Offer fields are null exactly when no credit-life cover was offered. Readers
 * that bind a policy to a product MUST branch on `offered` rather than
 * assuming the identity is present.
 */
export type VerifiedCreditLifeEvidence =
  Omit<
    CreditLifeDisclosureEvidence,
    "acknowledgedAt" | "acknowledgedBy" | "version" | "productId" | "productName" | "insurerId" | "insurerName"
  > & {
    version:
      | typeof CREDIT_LIFE_DISCLOSURE_VERSION
      | typeof CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION
    offered: boolean
    productId: string | null
    productName: string | null
    insurerId: string | null
    insurerName: string | null
    disclosureSha256: string
  }

export type VerifiedCreditLifeDisclosure =
  | { ok: true; evidence: VerifiedCreditLifeEvidence }
  | { ok: false; reason: "missing" | "premium_mismatch" | "hash_mismatch" }

export function verifyStoredCreditLifeDisclosure(
  stored: StoredCreditLifeDisclosure,
  terms: { principalCents: number; termDays: number },
): VerifiedCreditLifeDisclosure {
  if (
    !isCreditLifeElection(stored.creditLifeElection)
    || !(stored.creditLifeDisclosureAcknowledgedAt instanceof Date)
    || typeof stored.creditLifeDisclosureAcknowledgedBy !== "string"
    || stored.creditLifeDisclosureAcknowledgedBy.trim() === ""
    || typeof stored.creditLifeDisclosureSha256 !== "string"
  ) {
    return { ok: false, reason: "missing" }
  }

  // No cover was offered: the four identity columns and the premium must ALL
  // be absent. A half-populated row is a corrupted record, not a no-offer one.
  if (stored.creditLifeDisclosureVersion === CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION) {
    if (
      stored.creditLifeElection !== "DECLINED"
      || stored.creditLifeProductId !== null
      || stored.creditLifeProductName !== null
      || stored.creditLifeInsurerId !== null
      || stored.creditLifeInsurerName !== null
      || stored.creditLifeMonthlyPremiumCents !== 0
    ) {
      return { ok: false, reason: "missing" }
    }
    const noOffer = {
      version: CREDIT_LIFE_NO_OFFER_DISCLOSURE_VERSION,
      election: "DECLINED",
      principalCents: terms.principalCents,
      termDays: terms.termDays,
    } as const
    const expected = createCreditLifeNoOfferDisclosureSha256(noOffer)
    if (stored.creditLifeDisclosureSha256 !== expected) {
      return { ok: false, reason: "hash_mismatch" }
    }
    return {
      ok: true,
      evidence: {
        ...noOffer,
        offered: false,
        monthlyPremiumCents: 0,
        productId: null,
        productName: null,
        insurerId: null,
        insurerName: null,
        disclosureSha256: expected,
      },
    }
  }

  if (
    typeof stored.creditLifeProductId !== "string"
    || stored.creditLifeProductId.trim() === ""
    || typeof stored.creditLifeProductName !== "string"
    || stored.creditLifeProductName.trim() === ""
    || typeof stored.creditLifeInsurerId !== "string"
    || stored.creditLifeInsurerId.trim() === ""
    || typeof stored.creditLifeInsurerName !== "string"
    || stored.creditLifeInsurerName.trim() === ""
    || stored.creditLifeDisclosureVersion !== CREDIT_LIFE_DISCLOSURE_VERSION
    || typeof stored.creditLifeDisclosureSha256 !== "string"
    || !(stored.creditLifeDisclosureAcknowledgedAt instanceof Date)
    || typeof stored.creditLifeDisclosureAcknowledgedBy !== "string"
    || stored.creditLifeDisclosureAcknowledgedBy.trim() === ""
  ) {
    return { ok: false, reason: "missing" }
  }

  const monthlyPremiumCents =
    calculateCreditLifeMonthlyPremiumCents(terms.principalCents)
  if (stored.creditLifeMonthlyPremiumCents !== monthlyPremiumCents) {
    return { ok: false, reason: "premium_mismatch" }
  }

  const evidence = {
    version: CREDIT_LIFE_DISCLOSURE_VERSION,
    election: stored.creditLifeElection,
    principalCents: terms.principalCents,
    termDays: terms.termDays,
    monthlyPremiumCents,
    productId: stored.creditLifeProductId,
    productName: stored.creditLifeProductName,
    insurerId: stored.creditLifeInsurerId,
    insurerName: stored.creditLifeInsurerName,
  } as const
  const expectedSha256 = createCreditLifeDisclosureSha256(evidence)
  if (stored.creditLifeDisclosureSha256 !== expectedSha256) {
    return { ok: false, reason: "hash_mismatch" }
  }
  return {
    ok: true,
    evidence: { ...evidence, offered: true, disclosureSha256: expectedSha256 },
  }
}

/**
 * The pre-approval terms a stored credit-life disclosure is checked against.
 *
 * The staff rail has to ask exactly the question the decision route enforces.
 * If the two derive their terms separately they can drift, and the rail then
 * either shows a blocker where approval would succeed or stays silent where
 * approval will 422 — a blocker chip that is wrong about whether it blocks is
 * worse than no chip. Deriving them once is what keeps them honest.
 *
 * Post-approval callers (agreement generation, disbursement) deliberately do
 * NOT use this: they check against the locked approval snapshot, because by
 * then the applied-for figures are no longer what the consumer is bound to.
 */
export function verifyAppliedCreditLifeDisclosure(
  application: StoredCreditLifeDisclosure & {
    appliedAmount: number
    appliedTermDays: number
  },
): VerifiedCreditLifeDisclosure {
  return verifyStoredCreditLifeDisclosure(application, {
    principalCents: application.appliedAmount,
    termDays: application.appliedTermDays,
  })
}
