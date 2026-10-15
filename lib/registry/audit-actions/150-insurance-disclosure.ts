import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Phase 2a: FAIS disclosure
  INSURANCE_FAIS_DISCLOSURE_RENDERED:     "INSURANCE_FAIS_DISCLOSURE_RENDERED",
  INSURANCE_FAIS_DISCLOSURE_ACKNOWLEDGED: "INSURANCE_FAIS_DISCLOSURE_ACKNOWLEDGED",
  INSURANCE_FAIS_GATE_REJECTED:           "INSURANCE_FAIS_GATE_REJECTED",
  INSURANCE_POLICY_AUTOBUNDLED:           "INSURANCE_POLICY_AUTOBUNDLED",
  INSURANCE_AUTOBUNDLE_SKIPPED:           "INSURANCE_AUTOBUNDLE_SKIPPED",
  INSURANCE_PATCH_FAIS_LOCKED:            "INSURANCE_PATCH_FAIS_LOCKED",
  // PPR / FAIS disclosure issued for an auto-bundled credit-life policy.
  INSURANCE_PPR_ISSUED:                   "INSURANCE_PPR_ISSUED",
  INSURANCE_PPR_ISSUE_FAILED:             "INSURANCE_PPR_ISSUE_FAILED",
  // Policyholder acknowledging the PPR disclosure themselves in the portal.
  // Before this, the ONLY writer of pprAcknowledgedAt was the staff route,
  // which took both the timestamp and the "acknowledged by" name from the
  // request body — an arbitrary, backdatable value asserted about a client who
  // may have done nothing. No UI ever called it, so in practice the FSCA
  // return's acknowledgement count (lib/fsca-return.ts) was zero by
  // construction — but any row that WAS written that way is indistinguishable
  // from a genuine acknowledgement and carries no audit row. Do not assume the
  // column is clean; see the legacy-row audit task before trusting it.
  INSURANCE_PPR_ACKNOWLEDGED:             "INSURANCE_PPR_ACKNOWLEDGED",
})
