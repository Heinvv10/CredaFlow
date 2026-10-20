-- Slice 5 part A, review round 2 (docs/asset-finance/SLICE5.md, deviation 40).
-- Hand-written: no Prisma model change.
--
-- The contact details a dealer typed for a person it captured are untrusted
-- until staff verify them (Client.dealerContactVerifiedAt, migration
-- 20261019120300). No deal, a dealer's or a staff one, is BOOKED while any
-- such person on it (its sole proprietor, or an active person of its entity)
-- is unverified: servicing messages go to those contacts from booking on, and
-- a dealer-captured borrower can reappear on a staff deal. Booking's load
-- step (lib/asset-finance/booking-load.ts) refuses first, with a reason.
CREATE OR REPLACE FUNCTION "guardDealerDealContactsVerified"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "Client" c
    WHERE c."tenantId" = NEW."tenantId" AND c."createdByDealerId" IS NOT NULL AND c."dealerContactVerifiedAt" IS NULL
      AND (c."id" = NEW."clientId" OR EXISTS (
        SELECT 1 FROM "EntityRelationship" r
        WHERE r."tenantId" = NEW."tenantId" AND r."entityId" = NEW."entityId" AND r."clientId" = c."id" AND r."active"))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A deal is booked only after staff verify the contact details a dealer captured for its people';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_dealer_contacts_verified" BEFORE UPDATE OF "status" ON "AssetFinanceDeal"
  FOR EACH ROW WHEN (NEW."status" = 'BOOKED' AND OLD."status" IS DISTINCT FROM 'BOOKED')
  EXECUTE FUNCTION "guardDealerDealContactsVerified"();
