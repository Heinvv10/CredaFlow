ALTER TABLE "LeaseTerminationQuote" DROP CONSTRAINT "LeaseTerminationQuote_amounts";
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_amounts" CHECK (
 "pvCents" >= 0 AND "penaltyCents" >= 0 AND "arrearsCents" >= 0 AND "invoiceVatCents" >= 0 AND "remainingRentals" >= 0
 AND "invoiceExclVatCents" >= 0 AND "insuranceProceedsCents" >= 0
 AND ("goodsValueCents" IS NULL OR "goodsValueCents" >= 0)
 AND jsonb_typeof("documentedCosts") = 'array'
 AND ((NOT "cpaCancellation" AND NOT "totalLoss" AND "invoiceExclVatCents" = "pvCents" + "penaltyCents")
   OR (("cpaCancellation" OR "totalLoss") AND "penaltyCents" = 0))
 AND "totalCents" = "invoiceExclVatCents" + "invoiceVatCents" + "arrearsCents"
 AND "validUntil" >= "quotedOn" AND ("lessorCancellation" OR "totalLoss" OR "terminationDate" >= "quotedOn")
 AND length(btrim("basis")) >= 10
 AND ("status" = 'ACCEPTED') = ("acceptedAt" IS NOT NULL)
 AND ("status" = 'ACCEPTED' OR ("taxInvoiceId" IS NULL AND "scheduleId" IS NULL))
 AND (NOT "totalLoss" OR length(btrim("lossEvidence")) > 0)
);
CREATE FUNCTION public."guardLeaseTotalLossEventDate"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW."totalLoss" AND (NEW."terminationDate" > (now() AT TIME ZONE 'Africa/Johannesburg')::date OR NOT EXISTS (
   SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
   AND NEW."terminationDate" >= (l."startDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date)) THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Total loss event must be between commencement and today';
 END IF;
 RETURN NEW;
END; $$;
CREATE TRIGGER "LeaseTerminationQuote_loss_event_date" BEFORE INSERT OR UPDATE ON "LeaseTerminationQuote" FOR EACH ROW EXECUTE FUNCTION public."guardLeaseTotalLossEventDate"();
ALTER TABLE "LeaseTerminationQuote" DROP CONSTRAINT "LeaseTerminationQuote_termination_window";
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_termination_window" CHECK (
 "lessorCancellation" OR "totalLoss" OR "terminationDate" BETWEEN "quotedOn" AND "quotedOn" + 60
);
