import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Asset finance NCA regime (lib/asset-finance/classification.ts,
  // app/api/asset-finance). NON_NCA switches off the consumer rules, so who
  // classified, who asked to change it and who agreed are audit questions.
  NCA_CLASSIFIED: "NCA_CLASSIFIED",
  NCA_OVERRIDE_REQUESTED: "NCA_OVERRIDE_REQUESTED",
  NCA_OVERRIDE_DECIDED: "NCA_OVERRIDE_DECIDED",
  // A decision refused for lack of authority or by the four-eyes rule.
  NCA_OVERRIDE_DECISION_REFUSED: "NCA_OVERRIDE_DECISION_REFUSED",
  // A classification refused (not an entity borrower, or already decided).
  NCA_CLASSIFY_REFUSED: "NCA_CLASSIFY_REFUSED",
  // Asset register and suppliers (app/api/asset-finance/assets, /suppliers).
  ASSET_CREATED: "ASSET_CREATED",
  ASSET_UPDATED: "ASSET_UPDATED",
  // A serial/VIN already financed: a possible double-financing attempt.
  ASSET_DUPLICATE_REFUSED: "ASSET_DUPLICATE_REFUSED",
  ASSET_VALUATION_RECORDED: "ASSET_VALUATION_RECORDED",
  SUPPLIER_CREATED: "SUPPLIER_CREATED",
  SUPPLIER_UPDATED: "SUPPLIER_UPDATED",
  SUPPLIER_BANK_ACCOUNT_REQUESTED: "SUPPLIER_BANK_ACCOUNT_REQUESTED",
  SUPPLIER_BANK_ACCOUNT_DECIDED: "SUPPLIER_BANK_ACCOUNT_DECIDED",
  // A decision refused for lack of authority or by the four-eyes rule.
  SUPPLIER_BANK_ACCOUNT_DECISION_REFUSED: "SUPPLIER_BANK_ACCOUNT_DECISION_REFUSED",
})
