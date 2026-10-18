CREATE OR REPLACE FUNCTION public."guardNcaSurplusRemittance"() RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE parent RECORD; account RECORD;
BEGIN
 IF TG_OP='INSERT' THEN NEW."createdAt":=now(); END IF;
 IF TG_OP<>'INSERT' THEN
  IF TG_OP<>'UPDATE' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus payment instructions are immutable'; END IF;
  IF OLD."status"='INSTRUCTED' AND NEW."status"='INSTRUCTED' THEN
   IF OLD."executedOn" IS NOT NULL OR NEW."executedOn" IS NULL OR NEW."executedById" IS NULL OR NEW."executionEvidenceDocumentId" IS NULL
     OR NEW."executionRecordedAt" IS NULL OR length(btrim(COALESCE(NEW."bankExecutionReference",''))) NOT BETWEEN 6 AND 200
     OR (to_jsonb(NEW)-ARRAY['executedOn','bankExecutionReference','executionEvidenceDocumentId','executedById','executionRecordedAt']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['executedOn','bankExecutionReference','executionEvidenceDocumentId','executedById','executionRecordedAt']) THEN
    RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Bank execution evidence is recorded once without changing its instruction';
   END IF;
   NEW."executionRecordedAt":=now();
   NEW."bankExecutionReference":=upper(btrim(NEW."bankExecutionReference"));
  ELSIF OLD."status"<>'HELD_NO_VERIFIED_ACCOUNT'  OR NEW."status"<>'INSTRUCTED'
    OR OLD."releasedAt" IS NOT NULL OR NEW."releasedAt" IS NULL OR NEW."releasedById" IS NULL
    OR (to_jsonb(NEW)-ARRAY['status','accountId','releasedAt','releasedById']) IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','accountId','releasedAt','releasedById'])
    OR NOT (EXISTS (SELECT 1 FROM "SurrenderRequest" s WHERE s."id"=NEW."surrenderId" AND s."tenantId"=NEW."tenantId" AND s."status" IN ('PROCEEDS_CREDITED','FINAL_NOTICE_ISSUED')) OR EXISTS (SELECT 1 FROM "Recovery" r WHERE r."id"=NEW."recoveryId" AND r."tenantId"=NEW."tenantId" AND r."status" IN ('PROCEEDS_APPLIED','FINAL_NOTICE_ISSUED','SURPLUS_HELD'))) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Only a held surplus may issue once after bank authorisation';
  END IF;
  IF OLD."status"='HELD_NO_VERIFIED_ACCOUNT' THEN NEW."releasedAt" := now(); END IF;
 ELSIF NEW."executedOn" IS NOT NULL OR NEW."bankExecutionReference" IS NOT NULL OR NEW."executionEvidenceDocumentId" IS NOT NULL OR NEW."executedById" IS NOT NULL OR NEW."executionRecordedAt" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Bank execution follows an existing instruction';
 ELSIF NEW."releasedAt" IS NOT NULL OR NEW."releasedById" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A surplus release follows its recorded exception';
 END IF;
 IF NEW."surrenderId" IS NOT NULL THEN
  SELECT "loanId", "status"::TEXT AS status,"refundCents" AS surplus,"finalNoticePath" AS notice_path INTO parent FROM "SurrenderRequest" WHERE "id"=NEW."surrenderId" AND "tenantId"=NEW."tenantId" FOR SHARE;
 ELSE
  SELECT "loanId", "status"::TEXT AS status,"surplusCents" AS surplus,"finalNoticePath" AS notice_path INTO parent FROM "Recovery" WHERE "id"=NEW."recoveryId" AND "tenantId"=NEW."tenantId" AND "route"='NCA_S131_ATTACHMENT' FOR SHARE;
 END IF;
 IF NOT FOUND OR (parent.status NOT IN ('PROCEEDS_CREDITED','PROCEEDS_APPLIED','FINAL_NOTICE_ISSUED') AND NOT (TG_OP='UPDATE' AND NEW."recoveryId" IS NOT NULL AND parent.status='SURPLUS_HELD')) OR NEW."amountCents" IS DISTINCT FROM parent.surplus THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus instruction equals the notice surplus';
 END IF;
 SELECT * INTO account FROM "NcaSurplusAccount" WHERE "tenantId"=NEW."tenantId" AND "loanId"=parent."loanId" FOR SHARE;
 IF NEW."status"='INSTRUCTED' THEN
  IF NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id"=parent."loanId" AND l."tenantId"=NEW."tenantId" AND l."status"='COMPLETED') THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus is remitted only after the loan is settled';
  END IF;
  IF account."id" IS DISTINCT FROM NEW."accountId" OR account."approvedById" IS NULL OR account."releaseAuthorisedById" IS NULL THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Surplus instruction requires verified bank and prior release authority';
  END IF;
 ELSIF account."approvedById" IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A verified bank account cannot be reported unavailable';
 END IF;
 IF NEW."executedOn" IS NOT NULL THEN
  PERFORM 1 FROM "EntityDocument" d WHERE d."id"=NEW."executionEvidenceDocumentId" AND d."tenantId"=NEW."tenantId" FOR UPDATE;
  IF parent.status NOT IN ('PROCEEDS_CREDITED','PROCEEDS_APPLIED','FINAL_NOTICE_ISSUED','SURPLUS_HELD') OR NEW."executedOn" < (COALESCE(OLD."releasedAt",OLD."createdAt") AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date OR NEW."executedOn">(now() AT TIME ZONE 'Africa/Johannesburg')::date
    OR NOT EXISTS (SELECT 1 FROM "EntityDocument" d JOIN "Loan" l ON l."id"=parent."loanId" AND l."tenantId"=NEW."tenantId"
      WHERE d."id"=NEW."executionEvidenceDocumentId" AND d."tenantId"=NEW."tenantId" AND d."deletedAt" IS NULL
        AND d."clientId" IS NOT DISTINCT FROM l."clientId" AND d."entityId" IS NOT DISTINCT FROM l."entityId"
        AND d."docType" IN ('BANK_STATEMENT','OTHER') AND d."uploadedByType"='staff' AND d."uploadedById"=NEW."executedById"
        AND d."contentSha256" ~ '^[0-9a-f]{64}$' AND d."fileSize">0) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Execution needs a prepared instruction, valid bank date and retained borrower-owned staff bank evidence';
  END IF;
 END IF;
 RETURN NEW;
END;
$function$;
