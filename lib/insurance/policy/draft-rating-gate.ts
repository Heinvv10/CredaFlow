// The rating gate on the FAIS disclosure-draft path.
//
// WHY IT LIVES ON THE DRAFT ROUTE AND NOT ON THE BIND. The draft route renders
// and issues a disclosure PDF to a client. Gating only the bind would let a
// mis-priced policy produce a client-facing regulatory document, and only then
// be refused — the artefact would already exist, already have been shown, and
// already carry a premium no insurer term supports. Nothing may reach that
// document that rating has not approved, so the gate sits in front of it.
//
// This is what turns `canSellProduct` from a report into a gate. Until now it
// had exactly one caller — the readiness panel — and no writer consulted it, so
// a product with no rate card could still be sold at any price an operator
// typed. That is closable now, and was not closable in Phase 1, for one
// reason: no insurance policies have been sold yet, so no staff capability is
// being withdrawn from anybody.
//
// SCOPE IS DELIBERATELY NARROW. Only FUNERAL_COVER and LIFE_INSURANCE are
// screened, because they are the only types that have rate cards. Credit life
// is priced by `lib/insurance/credit-life-*` off the loan principal and is
// bound automatically at disbursement; the short-term types are priced
// elsewhere again. Screening either against a rate table they do not have would
// refuse every draft of them — the exact "un-gating a dead path is a launch"
// mistake in reverse: gating a live path against configuration it never had.

import type { InsurancePolicyType, PrismaClient } from "@prisma/client"
import { formatCents, toCents, type MoneyInput } from "../rand-cents"
import { canSellProduct } from "../product-readiness"
import { resolveActiveRateTable } from "../rating/rate-table"
import { rateQuote } from "../rating/rate-quote"

/**
 * The policy types priced from an `InsuranceRateTable`.
 *
 * A type absent from this list is not screened here at all. Read the module
 * header before adding one: the addition is a gate on a live path, and a type
 * without rate cards would have every draft refused.
 */
export const RATED_POLICY_TYPES: readonly InsurancePolicyType[] = ["FUNERAL_COVER", "LIFE_INSURANCE"]

export function requiresRating(type: string): boolean {
  return (RATED_POLICY_TYPES as readonly string[]).includes(type)
}

export type DraftRatingRefusal =
  | "PRODUCT_REQUIRED"
  | "PRODUCT_NOT_SELLABLE"
  | "NO_DATE_OF_BIRTH"
  | "RATING_FAILED"
  | "PREMIUM_MISMATCH"

export type DraftRatingResult =
  | { ok: true; derivedPremium: string }
  | { ok: false; reason: DraftRatingRefusal; detail: string; derivedPremium: string | null }

export interface ScreenDraftRatingParams {
  tenantId: string
  productId: string | null
  type: string
  /**
   * Rands, matching what the draft route signs into the token.
   *
   * `MoneyInput`, NOT `number`. Prisma's `Decimal.toJSON()` returns a STRING,
   * so any figure that has crossed JSON arrives as `"420"` rather than `420`.
   * Typing these `number` compiles clean and then compares a string to a number
   * at runtime — under `===` that is ALWAYS false, which would 409 every
   * FUNERAL_COVER and LIFE_INSURANCE draft while the gate looked like it was
   * working. `toCents` reads all three forms exactly, and the comparison below
   * is in integer cents for the same reason.
   */
  sumAssured: MoneyInput
  premiumAmount: MoneyInput
  /** The client the cover is for. Null date of birth cannot be rated. */
  clientDateOfBirth: Date | null
  /** The instant the card is resolved and the age computed at. Caller-supplied. */
  at: Date
}

type DraftRatingReader = Pick<PrismaClient, "insuranceRateTable" | "insuranceEligibilityRule">

/**
 * Does the requested premium match what the product's ACTIVE rate card
 * produces for this client and this cover?
 *
 * The draft is for ONE life — the client themselves, as the main member. That
 * is what a standalone disclosure draft is: a single named client, one sum
 * assured, one premium. A multi-life family quote goes through
 * `lib/insurance/quote/create.ts` and binds via the quote path, where every
 * life is rated individually.
 *
 * Comparison is in exact cents. Comparing the rand floats would let a premium
 * that differs by a fraction of a cent pass, and `Decimal(12,2)` would then
 * round it into a figure the card never produced.
 */
export async function screenDraftRating(
  prisma: DraftRatingReader,
  params: ScreenDraftRatingParams,
): Promise<DraftRatingResult> {
  const { tenantId, productId, type, sumAssured, premiumAmount, clientDateOfBirth, at } = params

  if (!requiresRating(type)) {
    // Not a rated type. The caller should not have asked, but answering "not
    // applicable" as a pass is wrong here — callers must branch on
    // `requiresRating` themselves so the skip is visible at the call site.
    return { ok: true, derivedPremium: formatCents(toCents(premiumAmount)) }
  }

  // Fail CLOSED on a missing product. Without one there is no rate card, so
  // there is nothing to check the price against — and an unverifiable price is
  // exactly what this gate exists to stop reaching a client.
  if (!productId) {
    return {
      ok: false,
      reason: "PRODUCT_REQUIRED",
      detail: `A ${type} disclosure requires a productId so the premium can be checked against the insurer's rate card`,
      derivedPremium: null,
    }
  }

  const readiness = await canSellProduct(prisma, { tenantId, productId, at })
  if (!readiness.sellable) {
    return {
      ok: false,
      reason: "PRODUCT_NOT_SELLABLE",
      detail: `Product is not ready to sell: ${readiness.reasons.join("; ")}`,
      derivedPremium: null,
    }
  }

  if (!clientDateOfBirth || Number.isNaN(clientDateOfBirth.getTime())) {
    return {
      ok: false,
      reason: "NO_DATE_OF_BIRTH",
      detail: "Client has no date of birth on record, so the rate card cannot be applied to them",
      derivedPremium: null,
    }
  }

  const resolved = await resolveActiveRateTable(prisma, { tenantId, productId, at })
  if (!resolved.ok) {
    // canSellProduct already reports this, so reaching here means the card
    // changed between the two reads. Refuse rather than fall through.
    return { ok: false, reason: "RATING_FAILED", detail: resolved.detail, derivedPremium: null }
  }

  const rated = rateQuote(
    resolved.table.bands,
    resolved.table.basis,
    [{ ref: "main", lifeType: "MAIN_MEMBER", dateOfBirth: clientDateOfBirth, sumAssured }],
    at,
  )
  if (!rated.ok) {
    return {
      ok: false,
      reason: "RATING_FAILED",
      detail: rated.failures.map((failure) => failure.detail).join("; "),
      derivedPremium: null,
    }
  }

  const derivedPremium = rated.totalPremium
  if (toCents(premiumAmount) !== rated.totalPremiumCents) {
    return {
      ok: false,
      reason: "PREMIUM_MISMATCH",
      // The derived figure is NAMED. A bare "premium is wrong" leaves the
      // operator guessing at a number the system already knows.
      detail: `Requested premium ${formatCents(toCents(premiumAmount))} does not match the ${derivedPremium} the product's ACTIVE rate table produces for this client and cover`,
      derivedPremium,
    }
  }

  return { ok: true, derivedPremium }
}
