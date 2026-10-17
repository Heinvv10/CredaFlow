-- AlterTable
ALTER TABLE "NcaSurplusAccount" ADD COLUMN     "recipient" TEXT NOT NULL DEFAULT 'CONSUMER';

-- CreateTable
CREATE TABLE "NcaSurplusDetermination" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "competingAgreement" BOOLEAN NOT NULL,
    "basis" TEXT NOT NULL,
    "evidenceDocumentId" TEXT NOT NULL,
    "recordedById" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NcaSurplusDetermination_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "NcaSurplusDetermination_tenantId_id_key" ON "NcaSurplusDetermination"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "NcaSurplusDetermination_tenantId_loanId_key" ON "NcaSurplusDetermination"("tenantId", "loanId");

-- AddForeignKey
ALTER TABLE "NcaSurplusDetermination" ADD CONSTRAINT "NcaSurplusDetermination_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NcaSurplusDetermination" ADD CONSTRAINT "NcaSurplusDetermination_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcaSurplusDetermination" ADD CONSTRAINT "NcaSurplusDetermination_tenantId_evidenceDocumentId_fkey" FOREIGN KEY ("tenantId", "evidenceDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "NcaSurplusDetermination" ADD CONSTRAINT "NcaSurplusDetermination_tenantId_recordedById_fkey" FOREIGN KEY ("tenantId", "recordedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- New enforcement on the new surplus objects: s127(6)'s competing agreement
-- determination is evidenced, immutable and never inferred from missing data.
ALTER TABLE "NcaSurplusAccount" ADD CONSTRAINT "NcaSurplusAccount_recipient" CHECK ("recipient" IN ('CONSUMER','TRIBUNAL'));
ALTER TABLE "NcaSurplusDetermination" ADD CONSTRAINT "NcaSurplusDetermination_basis" CHECK (length(btrim("basis")) BETWEEN 20 AND 2000);
CREATE FUNCTION public."guardNcaSurplusDetermination"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The evidenced competing credit agreement determination is retained unchanged'; END IF;
 PERFORM 1 FROM "Loan" l WHERE l."tenantId"=NEW."tenantId" AND l."id"=NEW."loanId" AND l."ncaRegime"='NCA' AND l."contractType"<>'LOAN' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A surplus determination requires its NCA asset-finance loan'; END IF;
 PERFORM 1 FROM "EntityDocument" d JOIN "Loan" l ON l."tenantId"=d."tenantId" AND l."id"=NEW."loanId"
 WHERE d."id"=NEW."evidenceDocumentId" AND d."tenantId"=NEW."tenantId" AND d."deletedAt" IS NULL
 AND (d."clientId",d."entityId") IS NOT DISTINCT FROM (l."clientId",l."entityId")
 AND d."uploadedByType"='staff' AND d."uploadedById"=NEW."recordedById" AND d."contentSha256" ~ '^[0-9a-f]{64}$' AND d."fileSize">0 FOR UPDATE OF d;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Competing credit determination requires retained borrower-owned staff evidence'; END IF;
 NEW."recordedAt":=now();
 RETURN NEW;
END; $$;
CREATE TRIGGER "NcaSurplusDetermination_guard" BEFORE INSERT OR UPDATE OR DELETE ON "NcaSurplusDetermination" FOR EACH ROW EXECUTE FUNCTION public."guardNcaSurplusDetermination"();
CREATE TRIGGER "NcaSurplusDetermination_no_truncate" BEFORE TRUNCATE ON "NcaSurplusDetermination" FOR EACH STATEMENT EXECUTE FUNCTION public."guardNcaSurplusDetermination"();
ALTER TABLE "NcaSurplusDetermination" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "NcaSurplusDetermination" FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON "NcaSurplusDetermination" USING (public.cf_rls_unrestricted() OR "tenantId"=public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId"=public.cf_rls_tenant());

CREATE FUNCTION public."requireNcaSurplusRecipient"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE competing BOOLEAN; loan_id TEXT;
BEGIN
 IF TG_TABLE_NAME='NcaSurplusAccount' THEN loan_id:=NEW."loanId";
 ELSIF NEW."surrenderId" IS NOT NULL THEN SELECT "loanId" INTO loan_id FROM "SurrenderRequest" WHERE "id"=NEW."surrenderId" AND "tenantId"=NEW."tenantId";
 ELSE SELECT "loanId" INTO loan_id FROM "Recovery" WHERE "id"=NEW."recoveryId" AND "tenantId"=NEW."tenantId"; END IF;
 SELECT "competingAgreement" INTO competing FROM "NcaSurplusDetermination" WHERE "tenantId"=NEW."tenantId" AND "loanId"=loan_id FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Determine competing registered credit agreements with evidence before surplus disposal; unknown is not no'; END IF;
 IF TG_TABLE_NAME='NcaSurplusAccount' THEN
  IF NEW."recipient" IS DISTINCT FROM (CASE WHEN competing THEN 'TRIBUNAL' ELSE 'CONSUMER' END) THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Competing registered credit agreement requires Tribunal remittance, otherwise the consumer'; END IF;
 ELSIF competing AND (NEW."status"<>'INSTRUCTED' OR NOT EXISTS (SELECT 1 FROM "NcaSurplusAccount" a WHERE a."id"=NEW."accountId" AND a."tenantId"=NEW."tenantId" AND a."recipient"='TRIBUNAL')) THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A competing registered credit agreement surplus must be remitted to the Tribunal; consumer account exception is unavailable';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "NcaSurplusAccount_recipient_guard" BEFORE INSERT OR UPDATE ON "NcaSurplusAccount" FOR EACH ROW EXECUTE FUNCTION public."requireNcaSurplusRecipient"();
CREATE TRIGGER "NcaSurplusRemittance_recipient_guard" BEFORE INSERT OR UPDATE ON "NcaSurplusRemittance" FOR EACH ROW EXECUTE FUNCTION public."requireNcaSurplusRecipient"();

-- An ordinary final notice confirms remittance, not merely its instruction.
-- The explicit product exception is an accurate timely account statement for
-- a consumer whose bank account remains unverified. Its payable stays open.
CREATE OR REPLACE FUNCTION public."requireNcaFinalNoticeRemittance"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE surplus INTEGER; covered BOOLEAN;
BEGIN
 IF NEW."status"::TEXT <> 'FINAL_NOTICE_ISSUED' OR OLD."status"::TEXT='FINAL_NOTICE_ISSUED' THEN RETURN NULL; END IF;
 IF TG_TABLE_NAME='SurrenderRequest' THEN
  surplus:=NEW."refundCents";
  SELECT EXISTS(SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."surrenderId"=NEW."id" AND r."tenantId"=NEW."tenantId" AND r."amountCents"=surplus AND (r."executedOn" IS NOT NULL OR r."status"='HELD_NO_VERIFIED_ACCOUNT')) INTO covered;
 ELSE
  IF NEW."route"<>'NCA_S131_ATTACHMENT' THEN RETURN NULL; END IF;
  surplus:=NEW."surplusCents";
  SELECT EXISTS(SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."recoveryId"=NEW."id" AND r."tenantId"=NEW."tenantId" AND r."amountCents"=surplus AND (r."executedOn" IS NOT NULL OR r."status"='HELD_NO_VERIFIED_ACCOUNT')) INTO covered;
 END IF;
 IF surplus>0 AND NOT covered THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='NCA final notice and surplus require actual executed remittance or an explicit unverified-consumer-account exception'; END IF;
 RETURN NULL;
END; $$;

CREATE FUNCTION public."retainNcaSurplusDeterminationEvidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM "NcaSurplusDetermination" a WHERE a."tenantId"=OLD."tenantId" AND a."evidenceDocumentId"=OLD."id") AND (TG_OP='DELETE' OR (to_jsonb(NEW)-'updatedAt') IS DISTINCT FROM (to_jsonb(OLD)-'updatedAt')) THEN
 RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Competing credit determination evidence is retained unchanged'; END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER "EntityDocument_surplus_determination" BEFORE UPDATE OR DELETE ON "EntityDocument" FOR EACH ROW EXECUTE FUNCTION public."retainNcaSurplusDeterminationEvidence"();

-- A legacy refund release is not proof of actual bank execution of this NCA
-- surplus. Keep its payable open even if another writer reaches the old path.
CREATE FUNCTION public."requireNcaSurplusExecutionForClosure"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."status"='CLOSED' AND OLD."status"<>'CLOSED' AND NEW."route" IN ('NCA_S127_SURRENDER','NCA_S131_ATTACHMENT') AND NEW."surplusCents">0 AND NOT EXISTS (
 SELECT 1 FROM "NcaSurplusRemittance" r WHERE r."tenantId"=NEW."tenantId" AND (r."recoveryId"=NEW."id" OR r."surrenderId"=NEW."surrenderRequestId") AND r."amountCents"=NEW."surplusCents" AND r."executedOn" IS NOT NULL) THEN
 RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='NCA surplus payable and statutory termination require actual evidenced remittance before closure'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "Recovery_actual_surplus_remittance" BEFORE UPDATE ON "Recovery" FOR EACH ROW EXECUTE FUNCTION public."requireNcaSurplusExecutionForClosure"();
CREATE OR REPLACE FUNCTION public."guardNcaSurplusDuplicateRefund"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "Recovery" c JOIN "NcaSurplusRemittance" r ON (r."recoveryId"=c."id" OR r."surrenderId"=c."surrenderRequestId")
 WHERE c."id"=NEW."recoveryId" AND c."tenantId"=NEW."tenantId") THEN
 RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='The NCA surplus uses its recorded instruction or held-account exception; authorise its account and retain actual bank execution instead of creating another refund'; END IF;
 RETURN NEW;
END; $$;
