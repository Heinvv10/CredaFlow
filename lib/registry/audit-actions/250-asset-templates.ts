import { defineAuditActions } from "../define"

export default defineAuditActions({
  // Lender-owned asset-finance templates (lib/asset-finance/documents/templates).
  // Versions, approvals and publications reuse the DOCUMENT_TEMPLATE_VERSION_* actions.
  ASSET_TEMPLATE_ADOPTED: "ASSET_TEMPLATE_ADOPTED",
  ASSET_DOCUMENT_ISSUED: "ASSET_DOCUMENT_ISSUED",
})
