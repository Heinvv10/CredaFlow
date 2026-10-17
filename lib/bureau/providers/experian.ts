/**
 * Experian behind BureauProvider. A WRAPPER ONLY: the request still goes
 * through buildExperianEnquiryInput + getCreditReport (lib/integrations/
 * experian.ts), so the wire format, the dry-run and its simulation guard are
 * unchanged. Credentials are the tenant's own sealed TenantConfig.experianKey,
 * with EXPERIAN_* env only for the ENV_CREDENTIALS_TENANT_SLUG tenant
 * (lib/integrations/tenant-credentials.ts), not the bureauCredentials bag.
 */
import {
  ENQUIRY_PURPOSE,
  getCreditReport,
  SIGMA_SCORE_MAX,
  SIGMA_SCORE_MIN,
  type ExperianResult,
} from "@/lib/integrations/experian"
import { buildExperianEnquiryInput } from "@/lib/integrations/experian-input"
import { rawPayloadSha256 } from "../normalise"
import {
  BureauProviderError,
  type BureauProvider,
  type BureauPurpose,
  type BureauReport,
} from "../types"

const PURPOSE_CODE: Record<BureauPurpose, string> = {
  AFFORDABILITY_ASSESSMENT: ENQUIRY_PURPOSE.AFFORDABILITY_ASSESSMENT,
  CREDIT_ASSESSMENT: ENQUIRY_PURPOSE.CREDIT_ASSESSMENT,
  ACCOUNT_MANAGEMENT: ENQUIRY_PURPOSE.ACCOUNT_MANAGEMENT,
  DEBT_COLLECTION: ENQUIRY_PURPOSE.DEBT_COLLECTION,
  FRAUD_PREVENTION: ENQUIRY_PURPOSE.FRAUD_PREVENTION,
}

/**
 * Account statuses that mean no instalment is being paid. Everything else
 * counts as open, including arrears and a missing status (null = unknown,
 * which affordability counts): arrears debt is still debt. "ACCOUNT CLOSED"
 * and "EARLY SETTLEMENT" are seen in the UAT samples; the rest are the usual
 * closing statuses, until Experian's status code table confirms the list.
 */
const CLOSED_STATUSES = new Set([
  "ACCOUNT CLOSED", "CLOSED", "EARLY SETTLEMENT", "SETTLED", "PAID UP", "PAID IN FULL", "WRITTEN OFF",
])

function accountOpen(status: string | null): boolean | null {
  if (status === null) return null
  return !CLOSED_STATUSES.has(status.trim().toUpperCase())
}

/** Experian's error classes that are about the consumer or our request: another
 *  bureau would refuse the same enquiry, so the run stops instead of falling back. */
const SUBJECT_CLASSES = new Set(["CONSENT", "DATA_QUALITY", "INPUT"])

export function experianReport(result: ExperianResult & { ok: true }): BureauReport {
  // Every account the bureau reported (nameless ones as UNKNOWN, unreadable
  // amounts as null). `accounts` is the fallback for a result built without
  // the full list (test doubles of getCreditReport).
  const tradelines = (result.obligationRows ?? result.accounts ?? []).map((account) => ({
    ...account,
    open: accountOpen(account.status),
  }))
  return {
    provider: "experian",
    simulated: result.simulated === true,
    simulationSource: result.simulated ? "experian" : null,
    score: {
      value: result.score ?? null,
      band: { min: SIGMA_SCORE_MIN, max: SIGMA_SCORE_MAX },
      riskGrade: result.riskGrade ?? null,
      unscoreable: result.unscoreable ?? false,
      declineReasons: result.declineReasons ?? [],
    },
    deceased: result.deceased ?? false,
    underDebtReview: result.underDebtReview ?? false,
    hasJudgement: result.hasJudgement ?? false,
    hasNotice: result.hasNotice ?? false,
    defaults: result.adverseInfo ?? [],
    // Not parsed from the v3 response yet (experian.ts); null, not zero.
    enquiriesLast90Days: null,
    pepIndicator: null,
    fraudIndicator: null,
    tradelines,
    // Experian's own total: OPEN/CURRENT accounts only, and an unreadable
    // amount counted as zero, so it can understate. It is only a floor —
    // bureauInstalmentTotalCents takes the larger of it and the tradelines
    // above, which hold every not-closed account, named or not.
    statedMonthlyInstalmentCents: result.totalMonthlyObligations ?? null,
    rawSha256: rawPayloadSha256(result.raw),
  }
}

export const experianBureau: BureauProvider = {
  id: "experian",
  displayName: "Experian",
  capabilities: {
    score: { min: SIGMA_SCORE_MIN, max: SIGMA_SCORE_MAX },
    tradelines: true,
    judgements: true,
    defaults: true,
    enquiryCount: false,
    pep: false,
    fraud: false,
    implemented: true,
  },
  credentialFields: [],
  // Consumer service line and site, for a consumer told a decline rests on this
  // bureau. Public contact details; confirm before a lender goes live.
  consumerContact: { phone: "0861 105 665", website: "www.experian.co.za" },
  async enquiry(request) {
    const input = buildExperianEnquiryInput({
      idNumber: request.consumer.idNumber,
      firstName: request.consumer.firstName,
      lastName: request.consumer.lastName,
      gender: request.consumer.gender,
      dateOfBirth: request.consumer.dateOfBirth,
      consentGranted: true,
      applicationId: request.reference,
    })
    // Whose Experian account: TenantConfig.experianKey (lib/integrations/tenant-credentials.ts).
    const result = await getCreditReport({ ...input, purpose: PURPOSE_CODE[request.purpose] }, request.tenantId)
    if (result.ok) return experianReport(result as ExperianResult & { ok: true })

    const detail = { providerCode: result.errorCode, errorClass: result.errorClass }
    const message = result.error ?? "Experian enquiry failed"
    if (result.errorCode === "NOT_CONFIGURED") throw new BureauProviderError("NOT_CONFIGURED", message, detail)
    if (result.errorClass && SUBJECT_CLASSES.has(result.errorClass)) {
      throw new BureauProviderError("SUBJECT_REJECTED", message, detail)
    }
    if (result.error === "Experian request timed out") throw new BureauProviderError("TIMEOUT", message, detail)
    throw new BureauProviderError("PROVIDER_ERROR", message, detail)
  },
}
