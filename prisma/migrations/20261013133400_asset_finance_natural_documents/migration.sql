-- EntityDocument predates natural-person asset deals. It is the deal evidence
-- store used by the payout controls, so allow exactly one borrower owner:
-- the entity or the sole-proprietor Client. Existing entity rows are unchanged.
ALTER TABLE "EntityDocument" ALTER COLUMN "entityId" DROP NOT NULL;
ALTER TABLE "EntityDocument" ADD COLUMN "clientId" TEXT;

CREATE INDEX "EntityDocument_tenantId_clientId_idx"
  ON "EntityDocument"("tenantId", "clientId");

ALTER TABLE "EntityDocument" ADD CONSTRAINT "EntityDocument_tenantId_clientId_fkey"
  FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id")
  ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE "EntityDocument" ADD CONSTRAINT "EntityDocument_borrower_xor"
  CHECK (num_nonnulls("entityId", "clientId") = 1);

CREATE OR REPLACE FUNCTION public."guardEntityDocumentBinding"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."storagePath" IS DISTINCT FROM OLD."storagePath"
    OR NEW."contentSha256" IS DISTINCT FROM OLD."contentSha256"
    OR NEW."dealId" IS DISTINCT FROM OLD."dealId"
    OR NEW."entityId" IS DISTINCT FROM OLD."entityId"
    OR NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."uploadedById" IS DISTINCT FROM OLD."uploadedById"
    OR NEW."uploadedByType" IS DISTINCT FROM OLD."uploadedByType"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An asset document''s bytes, borrower, deal and uploader are fixed when it is written';
  END IF;
  RETURN NEW;
END;
$function$;
