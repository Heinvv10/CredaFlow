/**
 * TransUnion behind BureauProvider. A WRAPPER ONLY around getCreditReport in
 * lib/integrations/transunion.ts: same endpoint, same credentials
 * (TenantConfig.transunionKey), same dry-run guard.
 *
 * The client's response field names are UNTESTED guesses (see that file) and
 * it reports no deceased / debt-review / judgement / notice flags, so those are
 * null here and TransUnion is not an approval bureau
 * (APPROVAL_BUREAU_PROVIDERS in lib/compliance/bureau.ts). The score scale is
 * not documented in-repo either: no band is claimed.
 */
import { getCreditReport } from "@/lib/integrations/transunion"
import { rawPayloadSha256 } from "../normalise"
import { BureauProviderError, type BureauProvider } from "../types"

export const transunionBureau: BureauProvider = {
  id: "transunion",
  displayName: "TransUnion",
  capabilities: {
    score: null,
    tradelines: true,
    judgements: false,
    defaults: true,
    enquiryCount: false,
    pep: false,
    fraud: false,
    implemented: true,
  },
  credentialFields: [],
  async enquiry(request) {
    const result = await getCreditReport({
      tenantId: request.tenantId,
      idNumber: request.consumer.idNumber,
      firstName: request.consumer.firstName,
      lastName: request.consumer.lastName,
    })
    if (!result.ok) {
      const message = result.error ?? "TransUnion enquiry failed"
      throw new BureauProviderError(message === "TransUnion not configured" ? "NOT_CONFIGURED" : "PROVIDER_ERROR", message)
    }
    return {
      provider: "transunion",
      simulated: result.simulated === true,
      simulationSource: result.simulated ? "transunion" : null,
      score: {
        value: result.score ?? null,
        band: null,
        riskGrade: result.riskGrade ?? null,
        unscoreable: typeof result.score !== "number",
        declineReasons: [],
      },
      deceased: null,
      underDebtReview: null,
      hasJudgement: null,
      hasNotice: null,
      defaults: result.adverseInfo ?? [],
      enquiriesLast90Days: null,
      pepIndicator: null,
      fraudIndicator: null,
      // The client does not interpret account status: unknown counts as open.
      tradelines: (result.accounts ?? []).map((account) => ({ ...account, open: null })),
      statedMonthlyInstalmentCents: result.totalMonthlyObligations ?? null,
      rawSha256: rawPayloadSha256(result.raw),
    }
  },
}
