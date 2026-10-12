import { planApplyTerm } from "@/lib/public-loan-products"

type TermRange = { min: number; max: number; fixed: boolean }

// The material payload for the apply POST (also what the idempotency
// fingerprint is computed over). The term goes through planApplyTerm so a
// catalogue-fixed product with a hidden, blank field still sends its fixed
// term instead of the raw field value.
export function buildApplyMaterialPayload<
  S1 extends object,
  S2 extends object,
  S3 extends { productType: string; termDays: string },
  A extends object,
>(args: {
  step1: S1
  step2: S2
  step3: S3
  attribution: A
  popiaConsent: boolean
  termRange: TermRange | undefined
}) {
  const { step1, step2, step3, attribution, popiaConsent, termRange } = args
  return {
    ...step1,
    ...step2,
    ...step3,
    termDays: planApplyTerm(step3.termDays, termRange).sendTermDays,
    ...attribution,
    popiaConsent,
  }
}
