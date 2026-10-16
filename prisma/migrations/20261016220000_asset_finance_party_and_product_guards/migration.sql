-- Fair Score audit E4/E5, review of #151.
--
-- 1. The approval's exceptions, each key with its severity when answered
--    (lib/asset-finance/deal-exception-severity.ts): payout and booking refuse
--    an exception that is new or worse. Written by the credit decision; fixed
--    once the deal is approved.
ALTER TABLE "AssetFinanceDeal" ADD COLUMN "approvalExceptions" JSONB NOT NULL DEFAULT '[]';

CREATE OR REPLACE FUNCTION public."freezeAssetDealApprovalExceptions"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."status" IN ('APPROVED', 'CONTRACTED', 'BOOKED')
    AND NEW."approvalExceptions" IS DISTINCT FROM OLD."approvalExceptions" THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An approved deal''s recorded exceptions are the record of what its approval answered: they are fixed';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_approval_exceptions_fixed" BEFORE UPDATE ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."freezeAssetDealApprovalExceptions"();

-- 2. The entity's people are what the credit decision cross-checked
--    (replaces the function of 20261013114200; same trigger name, now also
--    on INSERT).
--    - Removing an active party (deactivate, re-role, move, delete) is refused
--      while a deal of the entity is under review (SUBMITTED, REFERRED) or
--      approved (APPROVED, CONTRACTED): a defaulting director cannot be
--      stepped off for the decision.
--    - Adding or reactivating a party is refused while a deal is APPROVED or
--      CONTRACTED: the approval did not see them. Under review it is allowed
--      (the decision re-reads the people); once BOOKED it is allowed too, as
--      booking re-ran the cross-check and the money has moved.
--    Every role counts: the cross-check reads all of them.
CREATE OR REPLACE FUNCTION public."guardEntityRelationshipOnOpenDeal"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."active" AND (TG_OP = 'DELETE' OR NOT NEW."active"
      OR NEW."role" IS DISTINCT FROM OLD."role" OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
      OR NEW."entityId" IS DISTINCT FROM OLD."entityId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId")
    AND EXISTS (
      SELECT 1 FROM "AssetFinanceDeal" d
      WHERE d."tenantId" = OLD."tenantId" AND d."entityId" = OLD."entityId"
        AND d."status" IN ('SUBMITTED', 'REFERRED', 'APPROVED', 'CONTRACTED')
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The entity has a deal under review or approved: its directors, trustees, sureties and other parties are fixed until the deal is decided and booked, declined or cancelled';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."active" AND (TG_OP = 'INSERT' OR NOT OLD."active"
      OR NEW."role" IS DISTINCT FROM OLD."role" OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
      OR NEW."entityId" IS DISTINCT FROM OLD."entityId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId")
    AND EXISTS (
      SELECT 1 FROM "AssetFinanceDeal" d
      WHERE d."tenantId" = NEW."tenantId" AND d."entityId" = NEW."entityId" AND d."status" IN ('APPROVED', 'CONTRACTED')
    ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The entity has an approved deal: no director, trustee, surety or other party is added or reactivated until it is booked or cancelled';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$function$;

DROP TRIGGER "EntityRelationship_fixed_on_open_deal" ON "EntityRelationship";
CREATE TRIGGER "EntityRelationship_fixed_on_open_deal" BEFORE INSERT OR UPDATE OR DELETE ON "EntityRelationship"
  FOR EACH ROW EXECUTE FUNCTION public."guardEntityRelationshipOnOpenDeal"();

-- 3. An asset-finance deal's application carries an ASSET_FINANCE product:
--    checked when the deal is written and when its application's product
--    changes (the generic application PATCH must not move it to a consumer
--    product).
CREATE OR REPLACE FUNCTION public."guardAssetDealProductKind"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  -- A missing application is the foreign key's to refuse.
  IF EXISTS (
    SELECT 1 FROM "LoanApplication" a JOIN "LoanProduct" p ON p."id" = a."productId"
    WHERE a."id" = NEW."applicationId" AND p."productType" <> 'ASSET_FINANCE'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An asset-finance deal''s application must carry an asset-finance product';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."guardAssetDealApplicationProductKind"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."productId" IS DISTINCT FROM OLD."productId"
    AND EXISTS (SELECT 1 FROM "AssetFinanceDeal" d WHERE d."applicationId" = NEW."id")
    AND NOT EXISTS (SELECT 1 FROM "LoanProduct" p WHERE p."id" = NEW."productId" AND p."productType" = 'ASSET_FINANCE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An asset-finance deal''s application must carry an asset-finance product';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_product_kind" BEFORE INSERT OR UPDATE OF "applicationId" ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetDealProductKind"();
CREATE TRIGGER "LoanApplication_asset_deal_product_kind" BEFORE UPDATE OF "productId" ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetDealApplicationProductKind"();

-- A product an asset-finance deal uses stays ASSET_FINANCE (the product
-- settings route refuses the change first, with its reason).
CREATE OR REPLACE FUNCTION public."guardAssetFinanceProductKind"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."productType" = 'ASSET_FINANCE' AND NEW."productType" IS DISTINCT FROM OLD."productType" AND EXISTS (
    SELECT 1 FROM "LoanApplication" a JOIN "AssetFinanceDeal" d ON d."applicationId" = a."id" WHERE a."productId" = OLD."id"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An asset-finance deal uses this product: it stays an asset-finance product';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "LoanProduct_asset_finance_kind_fixed" BEFORE UPDATE OF "productType" ON "LoanProduct"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetFinanceProductKind"();
