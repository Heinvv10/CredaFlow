-- A lender's own asset-finance legal wording (lib/asset-finance/documents/templates).
-- Its own migration: a new enum value cannot be used in the transaction that adds it.
ALTER TYPE "DocumentTemplateKind" ADD VALUE 'ASSET_FINANCE';
