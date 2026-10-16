import type {
  ApplicationProduct,
  ApplicationWizardData,
} from "@/components/applications/wizard/types"
import { AFFORDABILITY_FAIL_REVIEW_REQUIRED } from "@/lib/applications/wizard-copy"

/**
 * Partial record of field-level validation error messages.
 * Keys are field names from the wizard data type; values are error strings.
 */
export type ValidationErrors<T> = Partial<Record<keyof T, string>>

export function validateStep1ClientSelect(
  d: ApplicationWizardData,
): ValidationErrors<ApplicationWizardData> {
  const errs: ValidationErrors<ApplicationWizardData> = {}
  if (!d.clientId) errs.clientId = "Pick a client (or create a new one)"
  return errs
}

export function validateStep2LoanParams(
  d: ApplicationWizardData,
  products: ApplicationProduct[],
): ValidationErrors<ApplicationWizardData> {
  const errs: ValidationErrors<ApplicationWizardData> = {}

  if (!d.productId) {
    errs.productId = "Required"
  }
  const product = products.find((p) => p.id === d.productId)
  if (d.productId && !product) {
    errs.productId = "Unknown product"
  }

  if (!d.appliedAmount.trim()) {
    errs.appliedAmount = "Required"
  } else if (!/^\d+(\.\d{1,2})?$/.test(d.appliedAmount)) {
    errs.appliedAmount = "Numeric amount in Rand"
  } else if (!(Number(d.appliedAmount) > 0)) {
    errs.appliedAmount = "Must be greater than zero"
  } else if (product) {
    const amt = Number(d.appliedAmount)
    if (amt < product.minAmount) errs.appliedAmount = `Below product minimum (R ${product.minAmount})`
    if (amt > product.maxAmount) errs.appliedAmount = `Above product maximum (R ${product.maxAmount})`
  }

  if (!d.appliedTermDays.trim()) {
    errs.appliedTermDays = "Required"
  } else if (!/^\d+$/.test(d.appliedTermDays)) {
    errs.appliedTermDays = "Whole number of days"
  } else if (product) {
    const t = Number(d.appliedTermDays)
    if (t < product.minTermDays) errs.appliedTermDays = `Below product minimum (${product.minTermDays} days)`
    if (t > product.maxTermDays) errs.appliedTermDays = `Above product maximum (${product.maxTermDays} days)`
  }

  if (!d.purpose.trim()) errs.purpose = "Required"

  return errs
}

export function validateStep3Affordability(
  d: ApplicationWizardData,
): ValidationErrors<ApplicationWizardData> {
  const errs: ValidationErrors<ApplicationWizardData> = {}
  if (!d.affordabilityFlag) {
    errs.affordabilityFlag = "Run the affordability check before continuing"
    return errs
  }
  if (d.affordabilityFlag === "FAIL" && !d.recklessLendingConfirmed) {
    errs.recklessLendingConfirmed = AFFORDABILITY_FAIL_REVIEW_REQUIRED
  }
  return errs
}

export function validateStep4Review(
  d: ApplicationWizardData,
  opts: { forReview?: boolean; creditLifeOffered?: boolean } = {},
): ValidationErrors<ApplicationWizardData> {
  const errs: ValidationErrors<ApplicationWizardData> = {}
  if (!opts.forReview) return errs

  // Defaults to true so a caller that forgets to pass it keeps the strict
  // behaviour rather than silently dropping a required disclosure. Only a
  // tenant with no active credit-life product passes false, and then there is
  // no offer to elect on and nothing to acknowledge.
  const creditLifeOffered = opts.creditLifeOffered ?? true
  if (creditLifeOffered) {
    if (d.creditLifeElection !== "ACCEPTED" && d.creditLifeElection !== "DECLINED") {
      errs.creditLifeElection = "The client must accept or decline the offered credit-life cover"
    }
    if (!d.creditLifeDisclosureAcknowledged) {
      errs.creditLifeDisclosureAcknowledged = "Confirm the exact offer was shown before the PASQ"
    }
  }
  if (!d.pasqAcknowledged) {
    errs.pasqAcknowledged = "Confirm the client understands the PASQ will follow during review"
  }
  if (!d.affordabilityDeclared) {
    errs.affordabilityDeclared = "Required to submit for review"
  }
  // `recklessLendingConfirmed` is enforced unconditionally by
  // `validateStep3Affordability` (composed by `validateAllApplication` before
  // this step). Re-checking here would silently overwrite Step 3's message
  // due to spread order if a future edit-from-review path skipped Step 3's
  // navigation gate. Single source of truth: Step 3.
  return errs
}

export function validateAllApplication(
  d: ApplicationWizardData,
  products: ApplicationProduct[],
  opts: { forReview?: boolean; creditLifeOffered?: boolean } = {},
): ValidationErrors<ApplicationWizardData> {
  return {
    ...validateStep1ClientSelect(d),
    ...validateStep2LoanParams(d, products),
    ...validateStep3Affordability(d),
    ...validateStep4Review(d, opts),
  }
}

/**
 * Returns PASS for `ndiPct <= 70`, FAIL otherwise.
 *
 * `ndiPct` is the percentage of net disposable income (NDI) consumed by the
 * proposed monthly instalment: `100 * instalment / NDI`.
 *
 * Matches the legacy `ApplicationForm`'s binary 70% NDI rule:
 *   - ndiPct ≤ 70  → PASS
 *   - ndiPct > 70  → FAIL
 *
 * Precondition: `ndiPct` must be `>= 0`. Caller must gate on `ndi > 0` before
 * calling — negative NDI (client has negative disposable income) must emit
 * FAIL at the call site and never reach this function. The current
 * implementation does NOT defend against negative input: a negative `ndiPct`
 * trivially satisfies `<= 70` and returns PASS, which would be wrong.
 *
 * MARGINAL is reserved as an enum value for a future credit-policy ticket
 * and is never emitted by this implementation.
 */
export function deriveAffordabilityFlag(
  ndiPct: number,
): "PASS" | "MARGINAL" | "FAIL" {
  if (ndiPct <= 70) return "PASS"
  return "FAIL"
}
