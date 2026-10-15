import { defineAuditActions } from "../define"

export default defineAuditActions({
  // IMS Phase 1: the insurer's rate card and acceptance terms. These are the
  // terms a quote is priced and screened against, so every change to them is
  // an auditable act — an activation in particular decides what every
  // subsequent policy is sold at.
  INSURANCE_RATE_TABLE_CREATED:      "INSURANCE_RATE_TABLE_CREATED",
  INSURANCE_RATE_TABLE_UPDATED:      "INSURANCE_RATE_TABLE_UPDATED",
  INSURANCE_RATE_TABLE_ACTIVATED:    "INSURANCE_RATE_TABLE_ACTIVATED",
  INSURANCE_RATE_TABLE_RETIRED:      "INSURANCE_RATE_TABLE_RETIRED",
  INSURANCE_RATE_TABLE_DELETED:      "INSURANCE_RATE_TABLE_DELETED",
  INSURANCE_RATE_BAND_CREATED:       "INSURANCE_RATE_BAND_CREATED",
  INSURANCE_RATE_BAND_UPDATED:       "INSURANCE_RATE_BAND_UPDATED",
  INSURANCE_RATE_BAND_DELETED:       "INSURANCE_RATE_BAND_DELETED",
  INSURANCE_ELIGIBILITY_RULE_CREATED: "INSURANCE_ELIGIBILITY_RULE_CREATED",
  INSURANCE_ELIGIBILITY_RULE_UPDATED: "INSURANCE_ELIGIBILITY_RULE_UPDATED",
  INSURANCE_ELIGIBILITY_RULE_DELETED: "INSURANCE_ELIGIBILITY_RULE_DELETED",
  // IMS Phase 2: quoting and the FAIS record of advice.
  //
  // INSURANCE_QUOTE_DRAFTED is not noise beside INSURANCE_QUOTE_CREATED — it
  // is the row that says a quote could NOT be priced or screened, and the
  // failures it carries are the evidence of what the insurer's configuration
  // refused. A quote that silently failed to price and left no trace is how an
  // operator concludes the product is broken with nothing to show anyone.
  INSURANCE_QUOTE_CREATED:           "INSURANCE_QUOTE_CREATED",
  INSURANCE_QUOTE_DRAFTED:           "INSURANCE_QUOTE_DRAFTED",
  INSURANCE_QUOTE_STATUS_CHANGED:    "INSURANCE_QUOTE_STATUS_CHANGED",
  INSURANCE_QUOTE_TRANSITION_REFUSED: "INSURANCE_QUOTE_TRANSITION_REFUSED",
  INSURANCE_ADVICE_RECORDED:         "INSURANCE_ADVICE_RECORDED",
  INSURANCE_ADVICE_REFUSED:          "INSURANCE_ADVICE_REFUSED",
  INSURANCE_QUOTE_DISCLOSURE_ISSUED: "INSURANCE_QUOTE_DISCLOSURE_ISSUED",
  INSURANCE_QUOTE_DISCLOSURE_REFUSED: "INSURANCE_QUOTE_DISCLOSURE_REFUSED",
  INSURANCE_QUOTE_BOUND:             "INSURANCE_QUOTE_BOUND",
  INSURANCE_QUOTE_BIND_REFUSED:      "INSURANCE_QUOTE_BIND_REFUSED",
  // The rating gate on the disclosure-draft path. A refusal here means a
  // premium was requested that the product's ACTIVE rate card does not
  // produce — recorded because it is an attempt to put a price in front of a
  // client that no insurer term supports.
  INSURANCE_DRAFT_RATING_REJECTED:   "INSURANCE_DRAFT_RATING_REJECTED",
  // Flipping the IMS module on or off for a tenant.
  //
  // It does NOT withdraw "the whole insurance API surface", which is what this
  // comment used to claim. `requireImsEnabled` gates app/api/insurance/**
  // only. With the flag off, app/api/insurers/**, app/api/products/insurance/**,
  // app/api/portal/insurance/**/ppr-acknowledge and app/api/cron/insurance-renewal
  // all still serve — deliberately, because live credit life reads insurer and
  // insurance-product records and gating them would break credit life.
  // Recorded because it opens and closes the gated surface plus the Insurance
  // and Compliance staff sections.
  IMS_MODULE_ENABLED:                "IMS_MODULE_ENABLED",
  IMS_MODULE_DISABLED:               "IMS_MODULE_DISABLED",
  BANK_SYNC_ENABLED:                 "BANK_SYNC_ENABLED",
  BANK_SYNC_DISABLED:                "BANK_SYNC_DISABLED",
})
