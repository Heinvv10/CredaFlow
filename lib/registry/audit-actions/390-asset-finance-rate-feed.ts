import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Asset finance reference-rate feed (lib/asset-finance/rate-feed-sync.ts):
  // the SARB feed could not be fetched or read, so nothing was recorded.
  // (A fetched value is audited as REFERENCE_RATE_RECORDED, source SARB_FEED.)
  LOAN_RATE_RESTATED: "LOAN_RATE_RESTATED",
  ASSET_FINANCE_RATE_NOTICE_DISPATCH: "ASSET_FINANCE_RATE_NOTICE_DISPATCH",
  REFERENCE_RATE_FEED_FAILED: "REFERENCE_RATE_FEED_FAILED",
})
