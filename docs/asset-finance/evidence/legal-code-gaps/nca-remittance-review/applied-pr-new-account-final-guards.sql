CREATE OR REPLACE FUNCTION public."guardNcaSurplusAccount"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE borrower RECORD;
BEGIN
 IF TG_OP IN ('DELETE','TRUNCATE') THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus bank verification is retained'; END IF;
 SELECT "clientId","entityId" INTO borrower FROM "Loan" WHERE "id"=NEW."loanId" AND "tenantId"=NEW."tenantId" AND "ncaRegime"='NCA' AND "contractType"<>'LOAN' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus account needs the NCA borrower bank evidence'; END IF;
 PERFORM 1 FROM "EntityDocument" d WHERE d."id"=NEW."evidenceDocumentId" AND d."tenantId"=NEW."tenantId" FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS (SELECT 1 FROM "EntityDocument" d WHERE d."id"=NEW."evidenceDocumentId" AND d."tenantId"=NEW."tenantId"
   AND (d."clientId",d."entityId") IS NOT DISTINCT FROM (borrower."clientId",borrower."entityId")
   AND d."deletedAt" IS NULL AND d."fileSize">0 AND d."docType" IN ('BANK_STATEMENT','OTHER') AND d."contentSha256" ~ '^[0-9a-f]{64}$' AND d."uploadedByType"='staff') THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus account needs the NCA borrower bank evidence';
 END IF;
 IF TG_OP='INSERT' THEN
  IF NEW."approvedById" IS NOT NULL OR NEW."releaseAuthorisedById" IS NOT NULL THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus account opens without approval'; END IF;
 ELSE
  IF (to_jsonb(NEW)-'approvedById'-'releaseAuthorisedById') IS DISTINCT FROM (to_jsonb(OLD)-'approvedById'-'releaseAuthorisedById')
    OR OLD."releaseAuthorisedById" IS NOT NULL OR (OLD."approvedById" IS NOT NULL AND NEW."approvedById" IS DISTINCT FROM OLD."approvedById") THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Verified surplus bank account evidence is immutable';
  END IF;
 END IF;
 IF NEW."approvedById" = NEW."createdById" OR NEW."releaseAuthorisedById" IN (NEW."createdById",NEW."approvedById")
   OR (NEW."releaseAuthorisedById" IS NOT NULL AND NEW."approvedById" IS NULL) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus verification and release require separate staff';
 END IF;
 IF EXISTS (SELECT 1 FROM unnest(ARRAY[NEW."createdById",NEW."approvedById",NEW."releaseAuthorisedById"]) actor
  WHERE actor IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "User" u WHERE u."id"=actor AND u."tenantId"=NEW."tenantId")) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus approval staff belong to this lender';
 END IF;
 RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public."requireNcaFinalNoticeRemittance"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE surplus INTEGER; covered BOOLEAN;
BEGIN
 IF NEW."status"::TEXT <> 'FINAL_NOTICE_ISSUED' OR OLD."status"::TEXT='FINAL_NOTICE_ISSUED' THEN RETURN NULL; END IF;
 PERFORM 1 FROM "Loan" WHERE "id"=NEW."loanId" AND "tenantId"=NEW."tenantId" FOR UPDATE;
 PERFORM 1 FROM "NcaSurplusAccount" WHERE "loanId"=NEW."loanId" AND "tenantId"=NEW."tenantId" FOR SHARE;
 IF TG_TABLE_NAME='SurrenderRequest' THEN
  surplus:=NEW."refundCents";
  SELECT EXISTS(SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."surrenderId"=NEW."id" AND r."tenantId"=NEW."tenantId" AND r."amountCents"=surplus AND (r."executedOn" IS NOT NULL OR (r."status"='HELD_NO_VERIFIED_ACCOUNT' AND EXISTS (SELECT 1 FROM "NcaSurplusDetermination" d WHERE d."tenantId"=NEW."tenantId" AND d."loanId"=NEW."loanId" AND NOT d."competingAgreement") AND NOT EXISTS (SELECT 1 FROM "NcaSurplusAccount" a WHERE a."tenantId"=NEW."tenantId" AND a."loanId"=NEW."loanId" AND a."recipient"='CONSUMER' AND a."approvedById" IS NOT NULL)))) INTO covered;
 ELSE
  IF NEW."route"<>'NCA_S131_ATTACHMENT' THEN RETURN NULL; END IF;
  surplus:=NEW."surplusCents";
  SELECT EXISTS(SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."recoveryId"=NEW."id" AND r."tenantId"=NEW."tenantId" AND r."amountCents"=surplus AND (r."executedOn" IS NOT NULL OR (r."status"='HELD_NO_VERIFIED_ACCOUNT' AND EXISTS (SELECT 1 FROM "NcaSurplusDetermination" d WHERE d."tenantId"=NEW."tenantId" AND d."loanId"=NEW."loanId" AND NOT d."competingAgreement") AND NOT EXISTS (SELECT 1 FROM "NcaSurplusAccount" a WHERE a."tenantId"=NEW."tenantId" AND a."loanId"=NEW."loanId" AND a."recipient"='CONSUMER' AND a."approvedById" IS NOT NULL)))) INTO covered;
 END IF;
 IF surplus>0 AND NOT covered THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='NCA final notice and surplus require actual executed remittance or an explicit unverified-consumer-account exception'; END IF;
 RETURN NULL;
END; $$;

