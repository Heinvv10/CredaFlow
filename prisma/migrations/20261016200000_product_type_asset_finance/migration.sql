-- An asset-finance product kind (Fair Score audit E4): asset-finance deals
-- accept only ASSET_FINANCE products, and consumer product lists exclude them.
-- Additive only: a new enum value cannot be used in the transaction that adds
-- it, so existing products are re-typed by the seed / product settings, not here.
ALTER TYPE "ProductType" ADD VALUE IF NOT EXISTS 'ASSET_FINANCE';
