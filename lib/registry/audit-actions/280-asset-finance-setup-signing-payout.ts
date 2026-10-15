import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Asset finance set-up (app/api/settings/asset-finance, app/api/asset-finance/vat-config):
  // the module switch, the payout dual-approval threshold and the VAT vendor details.
  ASSET_FINANCE_MODULE_ENABLED: "ASSET_FINANCE_MODULE_ENABLED",
  ASSET_FINANCE_MODULE_DISABLED: "ASSET_FINANCE_MODULE_DISABLED",
  ASSET_PAYOUT_DUAL_APPROVAL_CHANGED: "ASSET_PAYOUT_DUAL_APPROVAL_CHANGED",
  VAT_CONFIG_UPDATED: "VAT_CONFIG_UPDATED",
  // Deal documents and signing (lib/asset-finance/signing-*.ts): who prepared
  // the documents, each e-signature, each wet-ink scan and its confirmation by
  // a second user, and the move to CONTRACTED. Refusals (four eyes, signers
  // outstanding) are audited too. Document reads go to DocumentAccessLog.
  ASSET_DEAL_DOCUMENTS_PREPARED: "ASSET_DEAL_DOCUMENTS_PREPARED",
  ASSET_DEAL_DOCUMENT_SIGNED: "ASSET_DEAL_DOCUMENT_SIGNED",
  ASSET_DEAL_WET_INK_UPLOADED: "ASSET_DEAL_WET_INK_UPLOADED",
  ASSET_DEAL_WET_INK_CONFIRMED: "ASSET_DEAL_WET_INK_CONFIRMED",
  ASSET_DEAL_CONTRACTED: "ASSET_DEAL_CONTRACTED",
  ASSET_DEAL_SIGNING_REFUSED: "ASSET_DEAL_SIGNING_REFUSED",
  // Payout gate and booking (lib/asset-finance/payout*.ts, booking.ts): each
  // checklist confirmation with its evidence, the payout's creation and its
  // (second-user) approval, and the booking that creates the Loan and
  // releases the payout. Refusals of any of these are audited too.
  ASSET_PAYOUT_CHECKLIST_CONFIRMED: "ASSET_PAYOUT_CHECKLIST_CONFIRMED",
  ASSET_PAYOUT_CREATED: "ASSET_PAYOUT_CREATED",
  ASSET_PAYOUT_APPROVED: "ASSET_PAYOUT_APPROVED",
  ASSET_PAYOUT_REFUSED: "ASSET_PAYOUT_REFUSED",
  ASSET_DEAL_BOOKED: "ASSET_DEAL_BOOKED",
  // A deal cancelled before booking (lib/asset-finance/deal-cancel.ts): its
  // payout, application and asset with it. Refusals are audited too.
  ASSET_DEAL_CANCELLED: "ASSET_DEAL_CANCELLED",
  ASSET_DEAL_CANCEL_REFUSED: "ASSET_DEAL_CANCEL_REFUSED",
})
