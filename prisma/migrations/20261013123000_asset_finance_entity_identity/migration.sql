-- Once documents are prepared, their borrower identity must remain the
-- identity used through contracting, booking and tax invoicing. The route
-- gives a field-specific refusal; this trigger closes direct and racing writes.
CREATE OR REPLACE FUNCTION public."guardBusinessEntitySignedIdentity"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF (NEW."type" IS DISTINCT FROM OLD."type"
      OR NEW."legalName" IS DISTINCT FROM OLD."legalName"
      OR NEW."tradingName" IS DISTINCT FROM OLD."tradingName"
      OR NEW."registrationNumber" IS DISTINCT FROM OLD."registrationNumber"
      OR NEW."mastersReference" IS DISTINCT FROM OLD."mastersReference"
      OR NEW."vatNumber" IS DISTINCT FROM OLD."vatNumber"
      OR NEW."addressLine1" IS DISTINCT FROM OLD."addressLine1"
      OR NEW."addressLine2" IS DISTINCT FROM OLD."addressLine2"
      OR NEW."city" IS DISTINCT FROM OLD."city"
      OR NEW."province" IS DISTINCT FROM OLD."province"
      OR NEW."postalCode" IS DISTINCT FROM OLD."postalCode"
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId")
    AND EXISTS (
      SELECT 1 FROM "AssetFinanceDeal" d
      WHERE d."tenantId" = OLD."tenantId" AND d."entityId" = OLD."id"
        AND (d."status" IN ('CONTRACTED', 'BOOKED')
          OR (d."status" = 'APPROVED' AND d."preparedSigners" IS NOT NULL))
    )
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The entity has prepared or contracted documents: its signed identity is fixed';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "BusinessEntity_signed_identity_fixed"
  BEFORE UPDATE ON "BusinessEntity"
  FOR EACH ROW EXECUTE FUNCTION public."guardBusinessEntitySignedIdentity"();
