ALTER TABLE "Loan" ADD COLUMN "commercialCancelledAt" timestamp(3), ADD COLUMN "commercialCancellationSaleId" text;
CREATE UNIQUE INDEX "Loan_commercialCancellationSaleId_key" ON "Loan"("commercialCancellationSaleId");
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_commercialCancellationSaleId_fkey" FOREIGN KEY ("commercialCancellationSaleId") REFERENCES "RemarketingSale"("id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_commercial_cancellation_pair" CHECK (("commercialCancelledAt" IS NULL) = ("commercialCancellationSaleId" IS NULL));
CREATE FUNCTION "guardCommercialCancellation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'UPDATE' AND OLD."commercialCancelledAt" IS NOT NULL AND (NEW."commercialCancelledAt" IS DISTINCT FROM OLD."commercialCancelledAt" OR NEW."commercialCancellationSaleId" IS DISTINCT FROM OLD."commercialCancellationSaleId") THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed commercial cancellation is permanent';
 END IF;
 IF NEW."commercialCancelledAt" IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM "RemarketingSale" sale JOIN "Recovery" recovery ON recovery."id" = sale."recoveryId" JOIN "TaxInvoice" invoice ON invoice."id" = sale."taxInvoiceId"
   WHERE sale."id" = NEW."commercialCancellationSaleId" AND sale."tenantId" = NEW."tenantId" AND sale."status" = 'COMPLETED'
    AND recovery."loanId" = NEW."id" AND NEW."ncaRegime" = 'NON_NCA' AND NEW."contractType" = 'INSTALMENT_SALE'
    AND (NEW."commercialCancelledAt" + INTERVAL '2 hours')::date = invoice."supplyDate"
 ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Commercial cancellation must match the completed sale and its actual supply date'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "Loan_commercial_cancellation_guard" BEFORE INSERT OR UPDATE ON "Loan" FOR EACH ROW EXECUTE FUNCTION "guardCommercialCancellation"();
CREATE FUNCTION "guardCancelledCommercialSchedule"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS (SELECT 1 FROM "Loan" WHERE "id" = OLD."loanId" AND "commercialCancelledAt" IS NOT NULL) AND (
  NEW."principalDue" <> OLD."principalDue" OR NEW."interestDue" > OLD."interestDue" OR NEW."totalDue" > OLD."totalDue"
  OR (OLD."commonLawContractualInterestDue" IS NOT NULL AND NEW."commonLawContractualInterestDue" IS DISTINCT FROM OLD."commonLawContractualInterestDue")
 ) THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Cancelled commercial terms cannot revive future contractual debt'; END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "RepaymentSchedule_commercial_cancelled_guard" BEFORE UPDATE ON "RepaymentSchedule" FOR EACH ROW EXECUTE FUNCTION "guardCancelledCommercialSchedule"();
