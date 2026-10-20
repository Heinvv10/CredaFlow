-- Slice 5 part A, review round 3. Hand-written: Prisma cannot express a
-- partial index, and `prisma migrate diff` leaves it and the trigger alone.
--
-- The trust checks on dealer-typed contacts (lib/clients/dealer-contact.ts,
-- guardDealerDealContactsVerified, the portal and servicing selectors) look
-- for clients a dealer captured that staff have not verified. They are few:
-- index only those rows.
CREATE INDEX "Client_unverified_dealer_contact_idx" ON "Client" ("tenantId")
  WHERE "createdByDealerId" IS NOT NULL AND "dealerContactVerifiedAt" IS NULL;

-- A person a dealer captured, with contact details staff have not verified,
-- is linked to a business only while that business has no deal beyond the
-- same dealer's own unsubmitted draft. Any other live deal (a staff one,
-- another dealer's, or the dealer's own once handed over) would send that
-- person its messages. Checked when a link is made, re-activated or pointed
-- at another person or business; lib/dealer/capture.ts answers 409 first.
CREATE OR REPLACE FUNCTION "guardEntityRelationshipDealerContact"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  person RECORD;
BEGIN
  IF NOT NEW."active" OR (TG_OP = 'UPDATE' AND OLD."active"
      AND NEW."clientId" IS NOT DISTINCT FROM OLD."clientId" AND NEW."entityId" IS NOT DISTINCT FROM OLD."entityId") THEN
    RETURN NEW;
  END IF;
  SELECT c."createdByDealerId", c."dealerContactVerifiedAt" INTO person
  FROM "Client" c WHERE c."id" = NEW."clientId" AND c."tenantId" = NEW."tenantId";
  IF person."createdByDealerId" IS NULL OR person."dealerContactVerifiedAt" IS NOT NULL THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM "AssetFinanceDeal" d
    WHERE d."tenantId" = NEW."tenantId" AND d."entityId" = NEW."entityId" AND d."status" <> 'CANCELLED'
      AND NOT (d."dealerId" IS NOT DISTINCT FROM person."createdByDealerId" AND d."dealerSubmittedAt" IS NULL)
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A person whose dealer-typed contact details staff have not verified joins a business only while it has no deal beyond that dealer''s own draft';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "EntityRelationship_dealer_contact_link" BEFORE INSERT OR UPDATE OF "active", "clientId", "entityId" ON "EntityRelationship"
  FOR EACH ROW EXECUTE FUNCTION "guardEntityRelationshipDealerContact"();
