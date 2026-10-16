-- Re-type existing asset-finance products as ASSET_FINANCE (Fair Score audit
-- E4). Before 20261016200000 there was no product kind, so asset-finance
-- products were stored as PERSONAL: after that migration such a product would
-- vanish from the new-deal list, be refused by deal creation (422) and still be
-- offered to consumers. A separate migration: the new enum value cannot be used
-- in the transaction that added it.
--
-- Re-typed: a product used by an asset-finance deal's application, or carrying
-- a demo-seed asset-finance code (AF-IS, AF-LEASE), and used by NO consumer
-- application or consumer loan. A product used by both is left as it is: its
-- consumer history stays consumer, and staff split it by hand.
SELECT set_config('app.rls_bypass', 'on', false);

UPDATE "LoanProduct" p
SET "productType" = 'ASSET_FINANCE'
WHERE p."productType" <> 'ASSET_FINANCE'
  AND (
    p."code" IN ('AF-IS', 'AF-LEASE')
    OR EXISTS (
      SELECT 1 FROM "LoanApplication" a
      JOIN "AssetFinanceDeal" d ON d."applicationId" = a."id"
      WHERE a."productId" = p."id"
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM "LoanApplication" a
    WHERE a."productId" = p."id"
      AND NOT EXISTS (SELECT 1 FROM "AssetFinanceDeal" d WHERE d."applicationId" = a."id")
  )
  AND NOT EXISTS (
    SELECT 1 FROM "Loan" l WHERE l."productId" = p."id" AND l."contractType" = 'LOAN'
  );

SELECT set_config('app.rls_bypass', '', false);
