-- An actual evidenced cancellation is independent of later possession or sale.
ALTER TABLE "Loan" ADD COLUMN "commercialCancelledAt" timestamp(3), ADD COLUMN "commercialCancellationSaleId" text;
CREATE UNIQUE INDEX "Loan_commercialCancellationSaleId_key" ON "Loan"("commercialCancellationSaleId");
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_commercialCancellationSaleId_fkey" FOREIGN KEY ("commercialCancellationSaleId") REFERENCES "RemarketingSale"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_commercial_cancellation_sale" CHECK ("commercialCancellationSaleId" IS NULL OR "commercialCancelledAt" IS NOT NULL);
CREATE TABLE "CommercialCancellation" (
 "id" text PRIMARY KEY, "tenantId" text NOT NULL, "loanId" text NOT NULL,
 "cancelledOn" date NOT NULL, "evidenceDocumentId" text NOT NULL, "basis" text NOT NULL,
 "cancellationConfirmed" boolean NOT NULL, "recordedById" text NOT NULL,
 "recordedAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 CONSTRAINT "CommercialCancellation_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "CommercialCancellation_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "CommercialCancellation_tenantId_evidenceDocumentId_fkey" FOREIGN KEY ("tenantId", "evidenceDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "CommercialCancellation_recordedById_fkey" FOREIGN KEY ("recordedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE RESTRICT,
 CONSTRAINT "CommercialCancellation_attested" CHECK ("cancellationConfirmed" AND length(trim("basis")) BETWEEN 10 AND 2000)
);
CREATE UNIQUE INDEX "CommercialCancellation_loanId_key" ON "CommercialCancellation"("loanId");
CREATE UNIQUE INDEX "CommercialCancellation_tenantId_loanId_key" ON "CommercialCancellation"("tenantId", "loanId");
CREATE FUNCTION "guardCommercialCancellationEvent"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE agreement "Loan";
BEGIN
 IF TG_OP <> 'INSERT' THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An evidenced commercial cancellation is immutable'; END IF;
 SELECT * INTO agreement FROM "Loan" WHERE "id" = NEW."loanId" AND "tenantId" = NEW."tenantId" FOR UPDATE;
 IF agreement."id" IS NULL OR agreement."ncaRegime" <> 'NON_NCA' OR agreement."contractType" <> 'INSTALMENT_SALE'
    OR agreement."status" NOT IN ('ACTIVE','DEFAULTED','PENDING_WRITE_OFF')
    OR NOT EXISTS (SELECT 1 FROM "RepaymentSchedule" WHERE "loanId" = agreement."id" AND "tenantId" = agreement."tenantId")
    OR NEW."cancelledOn" < (agreement."startDate" + INTERVAL '2 hours')::date OR NEW."cancelledOn" > (CURRENT_TIMESTAMP + INTERVAL '2 hours')::date THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cancellation needs an open commercial instalment sale and an actual date from contract start through today'; END IF;
 IF NOT EXISTS (SELECT 1 FROM "User" WHERE "id" = NEW."recordedById" AND "tenantId" = NEW."tenantId" AND "active" AND "role" IN ('LOAN_ADMIN','ADMIN','SUPER_ADMIN')) THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Commercial cancellation needs an authorised staff verifier'; END IF;
 -- Lock after the agreement, before validating live evidence. A concurrent
 -- soft deletion must either commit first and be refused here, or wait and
 -- be refused by the evidence immutability guard after this event commits.
 PERFORM 1 FROM "EntityDocument" evidence WHERE evidence."id" = NEW."evidenceDocumentId" AND evidence."tenantId" = NEW."tenantId"
   AND evidence."entityId" = agreement."entityId" AND evidence."docType" = 'LEGAL_DOCUMENT' AND evidence."uploadedByType" = 'staff' AND evidence."deletedAt" IS NULL
   AND (evidence."dealId" IS NULL OR EXISTS (SELECT 1 FROM "AssetFinanceDeal" deal WHERE deal."id" = evidence."dealId" AND deal."loanId" = agreement."id" AND deal."tenantId" = agreement."tenantId")) FOR UPDATE OF evidence;
 IF NOT FOUND THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cancellation needs live staff legal evidence of the same borrower and agreement'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "CommercialCancellation_event_guard" BEFORE INSERT OR UPDATE OR DELETE ON "CommercialCancellation" FOR EACH ROW EXECUTE FUNCTION "guardCommercialCancellationEvent"();
CREATE TRIGGER "CommercialCancellation_no_truncate" BEFORE TRUNCATE ON "CommercialCancellation" FOR EACH STATEMENT EXECUTE FUNCTION "guardCommercialCancellationEvent"();
CREATE FUNCTION "guardCommercialCancellation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND OLD."commercialCancelledAt" IS NOT NULL AND (NEW."commercialCancelledAt" IS DISTINCT FROM OLD."commercialCancelledAt"
  OR (OLD."commercialCancellationSaleId" IS NOT NULL AND NEW."commercialCancellationSaleId" IS DISTINCT FROM OLD."commercialCancellationSaleId")) THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An actual commercial cancellation is permanent'; END IF;
 IF NEW."commercialCancelledAt" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "CommercialCancellation" event WHERE event."tenantId" = NEW."tenantId" AND event."loanId" = NEW."id"
   AND (NEW."commercialCancelledAt" + INTERVAL '2 hours')::date = event."cancelledOn") THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Commercial cancellation must match its independently evidenced actual event'; END IF;
 IF NEW."commercialCancellationSaleId" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "RemarketingSale" sale JOIN "Recovery" recovery ON recovery."id" = sale."recoveryId" JOIN "TaxInvoice" invoice ON invoice."id" = sale."taxInvoiceId"
   WHERE sale."id" = NEW."commercialCancellationSaleId" AND sale."tenantId" = NEW."tenantId" AND sale."status" = 'COMPLETED' AND recovery."loanId" = NEW."id"
    AND (NEW."commercialCancelledAt" + INTERVAL '2 hours')::date <= invoice."supplyDate"
 ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A commercial sale follows the actual cancellation date'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "Loan_commercial_cancellation_guard" BEFORE INSERT OR UPDATE ON "Loan" FOR EACH ROW EXECUTE FUNCTION "guardCommercialCancellation"();
CREATE FUNCTION "requireCommercialCancellationBound"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS (SELECT 1 FROM "Loan" WHERE "id" = NEW."loanId" AND "tenantId" = NEW."tenantId" AND ("commercialCancelledAt" + INTERVAL '2 hours')::date = NEW."cancelledOn") THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The actual cancellation and its contractual-interest cutoff commit together'; END IF;
 RETURN NULL;
END; $$;
CREATE CONSTRAINT TRIGGER "CommercialCancellation_bound" AFTER INSERT ON "CommercialCancellation" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "requireCommercialCancellationBound"();
CREATE FUNCTION "guardCancelledCommercialSchedule"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "Loan" WHERE "id" = OLD."loanId" AND "commercialCancelledAt" IS NOT NULL) AND (
  NEW."principalDue" <> OLD."principalDue" OR NEW."interestDue" > OLD."interestDue" OR NEW."totalDue" > OLD."totalDue"
  OR (OLD."commonLawContractualInterestDue" IS NOT NULL AND NEW."commonLawContractualInterestDue" IS DISTINCT FROM OLD."commonLawContractualInterestDue")
 ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cancelled commercial terms cannot revive future contractual debt'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "RepaymentSchedule_commercial_cancelled_guard" BEFORE UPDATE ON "RepaymentSchedule" FOR EACH ROW EXECUTE FUNCTION "guardCancelledCommercialSchedule"();
CREATE FUNCTION "guardCommercialCancellationEvidence"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "CommercialCancellation" WHERE "evidenceDocumentId" = OLD."id") THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Commercial cancellation evidence is immutable'; END IF;
 IF TG_OP = 'DELETE' THEN RETURN OLD; END IF; RETURN NEW;
END; $$;
CREATE TRIGGER "EntityDocument_commercial_cancellation_evidence" BEFORE UPDATE OR DELETE ON "EntityDocument" FOR EACH ROW EXECUTE FUNCTION "guardCommercialCancellationEvidence"();
ALTER TABLE "CommercialCancellation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "CommercialCancellation" FORCE ROW LEVEL SECURITY;
CREATE POLICY "tenant_isolation" ON "CommercialCancellation" USING (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant()) WITH CHECK (public.cf_rls_unrestricted() OR "tenantId" = public.cf_rls_tenant());

CREATE FUNCTION "guardCommercialSaleCancellation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."status" = 'COMPLETED' AND EXISTS (
  SELECT 1 FROM "Recovery" recovery JOIN "Loan" agreement ON agreement."id" = recovery."loanId"
   WHERE recovery."id" = NEW."recoveryId" AND agreement."ncaRegime" = 'NON_NCA' AND agreement."contractType" = 'INSTALMENT_SALE'
 ) AND NOT EXISTS (
  SELECT 1 FROM "Recovery" recovery JOIN "CommercialCancellation" event ON event."loanId" = recovery."loanId" AND event."tenantId" = NEW."tenantId"
   JOIN "TaxInvoice" invoice ON invoice."id" = NEW."taxInvoiceId"
   WHERE recovery."id" = NEW."recoveryId" AND event."cancelledOn" <= invoice."supplyDate"
 ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A commercial sale needs its independently evidenced actual cancellation first'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "RemarketingSale_commercial_cancellation_guard" BEFORE INSERT OR UPDATE ON "RemarketingSale" FOR EACH ROW EXECUTE FUNCTION "guardCommercialSaleCancellation"();
