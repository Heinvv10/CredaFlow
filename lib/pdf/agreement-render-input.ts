import type { LoanCalcResult } from "@/lib/loan-calculator"

/**
 * The ONE mapping from persisted agreement evidence to credit-agreement render
 * options.
 *
 * Extracted because two routes must produce byte-identical renders from the
 * same stored evidence: `POST /agreement` mints the unsigned document, and
 * `POST /agreement/countersign` re-renders it to stamp the executed artifact.
 * A second copy of this mapping could silently disagree with the first, and the
 * symptom would be an executed agreement whose CONTENT differs from the one the
 * consumer signed — authoritative-looking and wrong. One function, both callers.
 *
 * Deliberately PURE and validation-free. Every gate (approval currency, PASQ
 * binding, credit-life availability, provider identity) stays in the generation
 * route where it belongs; this only maps already-verified evidence onto the
 * renderer's shape. Countersignature re-renders from evidence that generation
 * already validated and froze.
 */
export interface AgreementRenderEvidence {
  providerIdentity: { tenantName: string; statutoryNcrNumber: string }
  client: {
    firstName: string
    lastName: string
    idNumber: string
    addressLine1?: string | null
    suburb?: string | null
    city?: string | null
    province?: string | null
    postalCode?: string | null
    phone?: string | null
  }
  application: { reference: string; agreementType?: string | null }
  /** Frozen approval inputs — the terms the decision was made on. */
  approvalInputs: {
    termDays: number
    interestRatePm: number
    interestModel: string
    monthlyServiceFeeCents: number
    initiationFeePayment: "DEFERRED" | "UPFRONT"
  }
  /** Derived from the frozen contract evidence, not recomputed from live data. */
  calc: LoanCalcResult
  startDate: Date
  maturityDate: Date
  /** Instant the acknowledged quotation was presented (from the PASQ evidence). */
  quotePresentedAt: Date
  quoteValidUntilDate: string
  creditLifeAutoBundleEligible: boolean
  /** The stored credit-life record is the no-offer disclosure. Required, so a
   *  caller must state it rather than let a missing `creditLife` imply it. */
  creditLifeNotOffered: boolean
  /**
   * Omitted entirely when no cover was offered. creditAgreement.ts prints its
   * "Offered Credit Life Product/Insurer/Premium" rows whenever this key is
   * present — including on a decline — so passing a blank product name would
   * state on an NCA document that cover was offered and turned down when none
   * was ever available.
   */
  creditLife?: {
    elected: boolean
    productName: string
    insurerName: string
    monthlyPremiumCents: number
    premiumPeriods?: number
    totalPremiumCents?: number
    billing?: unknown
  }
}

/** Everything the renderer needs, minus `variant` and `execution`, which the
 *  caller supplies: generation renders unsigned, countersignature renders the
 *  same document with both signatures stamped on. */
export function buildAgreementRenderInput(evidence: AgreementRenderEvidence) {
  return {
    // The evidence keeps its stored field names; the document takes the
    // provider as a LenderIdentity.
    lender: {
      legalName: evidence.providerIdentity.tenantName,
      ncrNumber: evidence.providerIdentity.statutoryNcrNumber,
    },
    client: {
      firstName: evidence.client.firstName,
      lastName: evidence.client.lastName,
      idNumber: evidence.client.idNumber,
      addressLine1: evidence.client.addressLine1 ?? undefined,
      city: evidence.client.city ?? undefined,
      suburb: evidence.client.suburb ?? undefined,
      province: evidence.client.province ?? undefined,
      postalCode: evidence.client.postalCode ?? undefined,
      phone: evidence.client.phone ?? undefined,
    },
    application: {
      reference: evidence.application.reference,
      agreementType: evidence.application.agreementType ?? undefined,
      appliedTermDays: evidence.approvalInputs.termDays,
    },
    calc: evidence.calc,
    product: {
      interestRatePm: evidence.approvalInputs.interestRatePm,
      interestModel: evidence.approvalInputs.interestModel,
      monthlyServiceFee: evidence.approvalInputs.monthlyServiceFeeCents,
    },
    startDate: evidence.startDate,
    maturityDate: evidence.maturityDate,
    quotePresentedAt: evidence.quotePresentedAt,
    quoteValidUntilDate: evidence.quoteValidUntilDate,
    willAutoBundleCl: evidence.creditLifeAutoBundleEligible,
    creditLife: evidence.creditLife,
    creditLifeNotOffered: evidence.creditLifeNotOffered,
    initiationFeePayment: evidence.approvalInputs.initiationFeePayment,
  }
}

/**
 * The per-page ceremony marker: a short prefix of the PASQ evidence digest.
 *
 * ONE definition so the quotation and the agreement cannot drift onto different
 * markers — two halves of a packet showing different references would defeat
 * the whole point, which is that a printed packet reads as a single ceremony.
 *
 * Returns undefined rather than a placeholder when no digest exists: a footer
 * printing "Ref unknown" on a statutory document is worse than no footer.
 */
export function ceremonyMarkerFor(pasqEvidenceSha256: string | null | undefined): string | undefined {
  if (!pasqEvidenceSha256 || pasqEvidenceSha256.length < 12) return undefined
  return pasqEvidenceSha256.slice(0, 12)
}
