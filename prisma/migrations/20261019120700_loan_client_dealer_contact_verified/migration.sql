-- Slice 5 part A, review round 3 (docs/asset-finance/SLICE5.md, deviation 40).
-- Hand-written: no Prisma model change.
--
-- A loan's messages go to its client's contact details from the payout on.
-- No Loan, a consumer loan or an asset-finance one, is created for a client a
-- dealer captured whose contact details staff have not verified
-- (Client.dealerContactVerifiedAt, migration 20261019120300). The consumer
-- disburse route refuses first (409); asset-finance booking already refuses
-- at its load step and at the deal's move into BOOKED. Named to fire before
-- the Loan's other BEFORE INSERT guards.
CREATE OR REPLACE FUNCTION "guardLoanClientDealerContact"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."clientId" IS NOT NULL AND EXISTS (
    SELECT 1 FROM "Client" c
    WHERE c."id" = NEW."clientId" AND c."tenantId" = NEW."tenantId"
      AND c."createdByDealerId" IS NOT NULL AND c."dealerContactVerifiedAt" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A loan is made only after staff verify the contact details a dealer captured for its client';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Loan_dealer_contact_verified" BEFORE INSERT ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION "guardLoanClientDealerContact"();
