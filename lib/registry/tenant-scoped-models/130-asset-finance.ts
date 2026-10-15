import { defineTenantScopedModels } from "../define"

export default defineTenantScopedModels([
  // Asset finance (docs/asset-finance/DESIGN.md). Non-null tenantId; the
  // routes run inside withTenantContext and also pass it explicitly.
  "BusinessEntity",
  "EntityRelationship",
  "NcaRegimeOverride",
  // Asset-finance rates and VAT documents — non-null tenantId, passed
  // explicitly on every query (the repricing cron has no frame). VatRate is
  // national and TaxInvoiceLine is scoped through its invoice: neither is listed.
  "ReferenceRate",
  "ContractRate",
  "TaxInvoice",
  "CreditNote",
  "VatConfig",
  "EntityDocument",
  "FinancedAsset",
  "AssetValuation",
  "Supplier",
  "SupplierBankAccount",
  "AssetFinanceDeal",
  "EntityFinancials",
  // Deal signing and payout (lib/asset-finance/signing-*.ts, payout*.ts).
  // Non-null tenantId, passed explicitly on every query; the seed runs
  // inside runWithTenant (prisma/seed/asset-finance.ts).
  "DealSigner",
  "PayoutChecklistItem",
  "Payout",
  "KycOverrideRequest",
] as const)
