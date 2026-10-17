-- CPA s14 cancellation and continuation; VAT Act s67; actual lease loss.
ALTER TABLE "LeaseRental" ADD COLUMN "cancellationCreditNoteId" TEXT;
CREATE UNIQUE INDEX "CreditNote_tenantId_id_key" ON "CreditNote"("tenantId", "id");
CREATE UNIQUE INDEX "LeaseRental_cancellationCreditNoteId_key" ON "LeaseRental"("cancellationCreditNoteId");
CREATE UNIQUE INDEX "LeaseRental_tenantId_cancellationCreditNoteId_key" ON "LeaseRental"("tenantId", "cancellationCreditNoteId");
ALTER TABLE "LeaseRental" ADD CONSTRAINT "LeaseRental_tenantId_cancellationCreditNoteId_fkey" FOREIGN KEY ("tenantId", "cancellationCreditNoteId") REFERENCES "CreditNote"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "LeaseEndOfTerm" ADD COLUMN "extensionNoticeByClientId" TEXT;
ALTER TABLE "LeaseTerminationQuote"
 ADD COLUMN "goodsValueCents" INTEGER,
 ADD COLUMN "documentedCosts" JSONB NOT NULL DEFAULT '[]',
 ADD COLUMN "lessorCancellation" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "totalLoss" BOOLEAN NOT NULL DEFAULT false,
 ADD COLUMN "insuranceProceedsCents" INTEGER NOT NULL DEFAULT 0,
 ADD COLUMN "lossEvidence" TEXT;
ALTER TABLE "LeaseTerminationQuote" DROP CONSTRAINT "LeaseTerminationQuote_amounts";
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_amounts" CHECK (
 "pvCents" >= 0 AND "penaltyCents" >= 0 AND "arrearsCents" >= 0 AND "invoiceVatCents" >= 0 AND "remainingRentals" >= 0
 AND "invoiceExclVatCents" >= 0 AND "insuranceProceedsCents" >= 0
 AND ("goodsValueCents" IS NULL OR "goodsValueCents" >= 0)
 AND jsonb_typeof("documentedCosts") = 'array'
 AND ((NOT "cpaCancellation" AND NOT "totalLoss" AND "invoiceExclVatCents" = "pvCents" + "penaltyCents")
   OR (("cpaCancellation" OR "totalLoss") AND "penaltyCents" = 0))
 AND "totalCents" = "invoiceExclVatCents" + "invoiceVatCents" + "arrearsCents"
 AND "validUntil" >= "quotedOn" AND ("lessorCancellation" OR "terminationDate" >= "quotedOn")
 AND length(btrim("basis")) >= 10
 AND ("status" = 'ACCEPTED') = ("acceptedAt" IS NOT NULL)
 AND ("status" = 'ACCEPTED' OR ("taxInvoiceId" IS NULL AND "scheduleId" IS NULL))
 AND (NOT "totalLoss" OR length(btrim("lossEvidence")) > 0)
);
CREATE OR REPLACE FUNCTION public."guardLeaseTerminationQuote"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'QUOTED' OR NOT EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
        AND l."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') AND (l."status" IN ('ACTIVE', 'DEFAULTED') OR (l."status" = 'COMPLETED' AND public."leaseTermEnd"(l."id", l."tenantId") > today))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote is written QUOTED for a running lease';
    END IF;
    IF NEW."quotedOn" <> today OR NEW."validUntil" > today + COALESCE((SELECT c."leaseTerminationQuoteValidDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 10) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote is dated today and valid for the tenant''s days at most';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."status" = 'ACCEPTED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An accepted termination quote is final';
  END IF;
  IF NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."quotedOn" IS DISTINCT FROM OLD."quotedOn" OR NEW."cpaCancellation" IS DISTINCT FROM OLD."cpaCancellation"
    OR NEW."lessorCancellation" IS DISTINCT FROM OLD."lessorCancellation" OR NEW."totalLoss" IS DISTINCT FROM OLD."totalLoss" OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."requestedByClientId" IS DISTINCT FROM OLD."requestedByClientId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Termination identity and notice are immutable';
  END IF;
  IF NEW."status" <> 'ACCEPTED' AND (to_jsonb(NEW) - ARRAY['status', 'acceptedAt', 'acceptedById', 'acceptedByClientId', 'taxInvoiceId', 'scheduleId'])
     IS DISTINCT FROM (to_jsonb(OLD) - ARRAY['status', 'acceptedAt', 'acceptedById', 'acceptedByClientId', 'taxInvoiceId', 'scheduleId']) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A termination quote''s figures are fixed when quoted';
  END IF;
  IF OLD."status" = 'QUOTED' AND NEW."status" = 'ACCEPTED' AND NOT NEW."cpaCancellation" AND NOT NEW."totalLoss" AND today > NEW."validUntil" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('The quote expired on %s', NEW."validUntil");
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public."guardLeaseRental"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_type TEXT;
  invoice_row RECORD;
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental is never deleted';
  END IF;
  IF TG_OP = 'INSERT' THEN
    SELECT l."contractType"::TEXT INTO loan_type FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
    IF loan_type IS NULL OR loan_type NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental belongs to an operating or full-maintenance lease loan';
    END IF;
    IF loan_type = 'OPERATING_LEASE' AND NEW."maintenanceExclVatCents" <> 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An operating lease rental carries no maintenance';
    END IF;
    IF NEW."taxInvoiceId" IS NOT NULL OR NEW."cancelledAt" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental is written uninvoiced';
    END IF;
    -- Only booking writes rentals: its deal is not BOOKED yet (it becomes
    -- BOOKED later in the same transaction; guardLeaseDealBooking).
    -- After booking, only a month-to-month extension's next rental: the next
    -- period, one month after the last, at the last rental and maintenance
    -- (lib/asset-finance/lease-charges.ts appendExtensionRental).
    IF EXISTS (SELECT 1 FROM "AssetFinanceDeal" d WHERE d."loanId" = NEW."loanId" AND d."tenantId" = NEW."tenantId" AND d."status" = 'BOOKED')
      AND NOT EXISTS (
        SELECT 1 FROM "LeaseEndOfTerm" e
        JOIN LATERAL (SELECT r.* FROM "LeaseRental" r WHERE r."loanId" = NEW."loanId" ORDER BY r."periodNo" DESC LIMIT 1) last ON TRUE
        WHERE e."loanId" = NEW."loanId" AND e."tenantId" = NEW."tenantId" AND e."status" = 'EXTENDING'
          -- In advance a rental due on the end date pays for the month after it: only rentals due before the end.
          AND (e."extensionEndsOn" IS NULL OR NEW."dueDate" < e."extensionEndsOn"
            OR (NEW."dueDate" = e."extensionEndsOn" AND NOT EXISTS (SELECT 1 FROM "AssetFinanceDeal" d
              WHERE d."loanId" = NEW."loanId" AND d."tenantId" = NEW."tenantId" AND d."rentalTiming" = 'ADVANCE')))
          AND NEW."periodNo" = last."periodNo" + 1
          AND NEW."dueDate" = (last."dueDate" + INTERVAL '1 month')::date
          AND NEW."rentalExclVatCents" = last."rentalExclVatCents" AND NEW."maintenanceExclVatCents" = last."maintenanceExclVatCents") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease''s rentals are written when it is booked, or one at a time on a month-to-month extension';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId"
    OR NEW."periodNo" IS DISTINCT FROM OLD."periodNo" OR NEW."dueDate" IS DISTINCT FROM OLD."dueDate"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s period, loan, schedule row and due date are fixed';
  END IF;
  IF OLD."taxInvoiceId" IS NOT NULL AND NEW."taxInvoiceId" IS DISTINCT FROM OLD."taxInvoiceId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s tax invoice is set once';
  END IF;
  IF NEW."cancelledAt" IS DISTINCT FROM OLD."cancelledAt" AND (
    OLD."cancelledAt" IS NOT NULL
    OR ((OLD."taxInvoiceId" IS NOT NULL OR NEW."taxInvoiceId" IS NOT NULL) AND NOT EXISTS (
      SELECT 1 FROM "CreditNote" c JOIN "TaxInvoice" i ON i."id" = c."invoiceId" AND i."tenantId" = c."tenantId"
      WHERE c."id" = NEW."cancellationCreditNoteId" AND c."tenantId" = NEW."tenantId" AND c."invoiceId" = OLD."taxInvoiceId"
        AND (SELECT SUM(n."inclVatCents") FROM "CreditNote" n WHERE n."invoiceId" = i."id" AND n."tenantId" = i."tenantId") = i."totalInclVatCents"))
    OR current_setting('credaflow.lease_terminate', true) IS DISTINCT FROM 'on'
    OR NOT EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId"
      AND q."status" = 'QUOTED' AND NEW."dueDate" > q."terminationDate"
      AND (q."cpaCancellation" OR q."totalLoss" OR q."validUntil" >= (now() AT TIME ZONE 'Africa/Johannesburg')::date))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental is cancelled once, uninvoiced, only by an accepted early termination';
  END IF;
  IF NEW."cancellationCreditNoteId" IS DISTINCT FROM OLD."cancellationCreditNoteId" AND (OLD."cancellationCreditNoteId" IS NOT NULL OR NEW."cancelledAt" IS NULL) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cancellation credit note is set once with the rental cancellation';
  END IF;
  IF OLD."cancelledAt" IS NOT NULL AND NEW."taxInvoiceId" IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cancelled lease rental is never invoiced';
  END IF;
  IF NEW."rentalExclVatCents" IS DISTINCT FROM OLD."rentalExclVatCents"
    OR NEW."maintenanceExclVatCents" IS DISTINCT FROM OLD."maintenanceExclVatCents"
    OR NEW."vatCents" IS DISTINCT FROM OLD."vatCents"
    OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents"
    OR NEW."vatRate" IS DISTINCT FROM OLD."vatRate" THEN
    IF current_setting('credaflow.lease_vat_supply', true) = 'on' THEN
      IF OLD."taxInvoiceId" IS NOT NULL OR OLD."cancelledAt" IS NOT NULL
        OR NEW."rentalExclVatCents" <> OLD."rentalExclVatCents" OR NEW."maintenanceExclVatCents" <> OLD."maintenanceExclVatCents"
        OR NOT EXISTS (SELECT 1 FROM "TaxInvoice" i
          WHERE i."id" = NEW."taxInvoiceId" AND i."tenantId" = NEW."tenantId" AND i."loanId" = NEW."loanId"
            AND i."vatRate" = NEW."vatRate" AND i."totalInclVatCents" = NEW."totalCents") THEN
        RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Supply-date VAT repricing requires its invoice and unchanged net rental';
      END IF;
    ELSE
    IF OLD."taxInvoiceId" IS NOT NULL OR NEW."taxInvoiceId" IS NOT NULL OR OLD."cancelledAt" IS NOT NULL
      OR current_setting('credaflow.lease_reprice', true) IS DISTINCT FROM 'on'
      OR NOT EXISTS (
        SELECT 1 FROM "ContractRate" c WHERE c."loanId" = NEW."loanId" AND c."tenantId" = NEW."tenantId"
          AND c."xmin" = pg_current_xact_id()::xid AND c."basis" <> 'FIXED' AND NEW."dueDate" >= c."effectiveDate"
          AND c."resultingRate" IS DISTINCT FROM (SELECT p."resultingRate" FROM "ContractRate" p WHERE p."loanId" = c."loanId"
            AND p."effectiveDate" < c."effectiveDate" ORDER BY p."effectiveDate" DESC LIMIT 1)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A lease rental''s amounts are fixed at booking; only a repricing changes them, before the rental is invoiced';
    END IF;
    IF NEW."vatRate" IS DISTINCT FROM OLD."vatRate"
      OR NEW."vatCents" <> "vatHalfUpCents"(NEW."rentalExclVatCents", NEW."vatRate") + "vatHalfUpCents"(NEW."maintenanceExclVatCents", NEW."vatRate") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A repriced rental keeps its booked VAT rate, its VAT recomputed on it';
    END IF;
    IF NEW."maintenanceExclVatCents" IS DISTINCT FROM OLD."maintenanceExclVatCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A repricing changes the rental, never the maintenance';
    END IF;
    END IF;
  END IF;
  IF OLD."taxInvoiceId" IS NULL AND NEW."taxInvoiceId" IS NOT NULL THEN
    SELECT i."loanId", i."totalInclVatCents", i."supplyDate" INTO invoice_row FROM "TaxInvoice" i
      WHERE i."id" = NEW."taxInvoiceId" AND i."tenantId" = NEW."tenantId";
    IF invoice_row."loanId" IS DISTINCT FROM NEW."loanId" OR invoice_row."totalInclVatCents" IS DISTINCT FROM NEW."totalCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s tax invoice is of its loan, for the rental''s total';
    END IF;
    -- Time of supply: the earlier of the due date and a payment towards the
    -- rental. Receipts settle the oldest rows first, so a payment has reached
    -- this rental only once the cash received by the supply date (allocated,
    -- unreversed, not a waiver, net of default charges)
    -- exceeds everything due on the earlier rows.
    IF invoice_row."supplyDate" > NEW."dueDate" OR (invoice_row."supplyDate" < NEW."dueDate" AND (NOT EXISTS (
        SELECT 1 FROM "RepaymentSchedule" s WHERE s."id" = NEW."scheduleId" AND s."tenantId" = NEW."tenantId" AND s."totalPaid" > 0)
      OR (SELECT COALESCE(SUM(p."amount" - p."defaultInterestAllocated" - p."chargeFeesAllocated"), 0) FROM "Payment" p
          WHERE p."loanId" = NEW."loanId" AND p."tenantId" = NEW."tenantId" AND p."reversed" = false
            AND p."allocationStatus" = 'ALLOCATED' AND p."paymentMethod"::TEXT <> 'WAIVER'
            AND (p."receivedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date <= invoice_row."supplyDate")
        <= (SELECT COALESCE(SUM(s."totalDue"), 0) FROM "RepaymentSchedule" s
          WHERE s."loanId" = NEW."loanId" AND s."tenantId" = NEW."tenantId" AND s."installmentNo" < NEW."periodNo"))) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A lease rental is supplied on its due date, or earlier only once a payment has reached it';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE OR REPLACE FUNCTION public."checkLeaseRentalCancelled"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."cancelledAt" IS NOT NULL AND OLD."cancelledAt" IS NULL AND NOT EXISTS (
      SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId"
        AND (q."status" = 'ACCEPTED' OR q."cpaCancellation" OR q."totalLoss") AND q."xmin" = pg_current_xact_id()::xid AND NEW."dueDate" > q."terminationDate") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A rental is cancelled only by a termination accepted with it';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE OR REPLACE FUNCTION public."guardLeaseEndOfTerm"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  loan_row RECORD;
  valuation RECORD;
  max_age INTEGER;
  returns_on DATE;
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease''s end of term is never deleted';
  END IF;
  SELECT l."contractType"::TEXT AS contract_type, l."assetId", a."registrationNumber" INTO loan_row
    FROM "Loan" l LEFT JOIN "FinancedAsset" a ON a."id" = l."assetId" AND a."tenantId" = l."tenantId"
    WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId";
  SELECT COALESCE((SELECT c."leasePurchaseValuationMaxAgeDays" FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"), 30) INTO max_age;
  IF TG_OP = 'INSERT' THEN
    IF loan_row.contract_type NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term belongs to a lease';
    END IF;
    IF NEW."status" IS DISTINCT FROM (CASE WHEN NEW."outcome" = 'EXTEND' THEN 'EXTENDING' ELSE 'ELECTED' END)::"LeaseEndStatus"
       OR NEW."taxInvoiceId" IS NOT NULL OR NEW."scheduleId" IS NOT NULL OR NEW."natisTransferConfirmedAt" IS NOT NULL
       OR NEW."inspectedOn" IS NOT NULL OR NEW."extensionNoticeOn" IS NOT NULL OR NEW."extensionEndsOn" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term is elected: ELECTED (EXTENDING for an extension), nothing billed yet';
    END IF;
    IF NEW."outcome" = 'PURCHASE' AND NOT public."purchaseValuationOk"(NEW."tenantId", loan_row."assetId", NEW."purchaseValuationId", NEW."purchasePriceExclVatCents", NEW."electedById", max_age) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('A purchase is at least the asset''s market value: an assessor''s or dealer''s valuation of this asset dated within %s days, recorded by someone other than the elector', max_age);
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."loanId" IS DISTINCT FROM OLD."loanId" OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId" OR NEW."origin" IS DISTINCT FROM OLD."origin"
    OR NEW."outcome" IS DISTINCT FROM OLD."outcome" OR NEW."electedAt" IS DISTINCT FROM OLD."electedAt"
    -- The elector changes only with a re-based purchase (the re-baser elects); purchase terms only while ELECTED.
    OR ((NEW."electedById" IS DISTINCT FROM OLD."electedById" OR NEW."electedByClientId" IS DISTINCT FROM OLD."electedByClientId")
      AND NOT (OLD."status" = 'ELECTED' AND NEW."outcome" = 'PURCHASE' AND NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId"))
    OR (OLD."status" <> 'ELECTED' AND (NEW."purchasePriceExclVatCents" IS DISTINCT FROM OLD."purchasePriceExclVatCents"
      OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId"))
    OR (OLD."taxInvoiceId" IS NOT NULL AND NEW."taxInvoiceId" IS DISTINCT FROM OLD."taxInvoiceId")
    OR (OLD."scheduleId" IS NOT NULL AND NEW."scheduleId" IS DISTINCT FROM OLD."scheduleId")
    OR (OLD."inspectedOn" IS NOT NULL AND (NEW."inspectedOn" IS DISTINCT FROM OLD."inspectedOn" OR NEW."finalReadingId" IS DISTINCT FROM OLD."finalReadingId"
      OR NEW."inspectionCondition" IS DISTINCT FROM OLD."inspectionCondition" OR NEW."inspectedById" IS DISTINCT FROM OLD."inspectedById"))
    OR (OLD."extensionNoticeOn" IS NOT NULL AND NEW."extensionNoticeOn" IS DISTINCT FROM OLD."extensionNoticeOn")
    OR (OLD."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" IS DISTINCT FROM OLD."extensionEndsOn"
      AND NOT EXISTS (SELECT 1 FROM "LeaseTerminationQuote" q WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId"
        AND q."status" = 'ACCEPTED' AND q."lessorCancellation" AND q."terminationDate" = NEW."extensionEndsOn"))
    OR (OLD."natisTransferConfirmedAt" IS NOT NULL AND NEW."natisTransferConfirmedAt" IS DISTINCT FROM OLD."natisTransferConfirmedAt")
    OR (OLD."status" IN ('INVOICED', 'COMPLETED') AND (NEW."excessUsageCents" IS DISTINCT FROM OLD."excessUsageCents"
      OR NEW."fundSettlementCents" IS DISTINCT FROM OLD."fundSettlementCents")) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term''s outcome, election, purchase terms, inspection, notice and billing are fixed once set';
  END IF;
  IF OLD."status" = 'COMPLETED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed end of term is final';
  END IF;
  -- An elected purchase is re-based only when its valuation has aged out: by staff (who become the
  -- elector), onto another valuation, at that valuation's amount, under the same rule as the election.
  IF NEW."purchasePriceExclVatCents" IS DISTINCT FROM OLD."purchasePriceExclVatCents" OR NEW."purchaseValuationId" IS DISTINCT FROM OLD."purchaseValuationId" THEN
    IF NEW."purchaseValuationId" IS NOT DISTINCT FROM OLD."purchaseValuationId" OR NEW."electedById" IS NULL OR NEW."electedByClientId" IS NOT NULL
       OR NOT EXISTS (SELECT 1 FROM "AssetValuation" o JOIN "AssetValuation" n ON n."id" = NEW."purchaseValuationId" AND n."tenantId" = o."tenantId"
         WHERE o."id" = OLD."purchaseValuationId" AND o."tenantId" = NEW."tenantId" AND o."valuedOn" < today - max_age
           AND NEW."purchasePriceExclVatCents" = n."amountCents"
           -- the house rule's valuation: no current market valuation of the asset is higher
           AND NOT EXISTS (SELECT 1 FROM "AssetValuation" b WHERE b."tenantId" = n."tenantId" AND b."assetId" = n."assetId"
             AND b."source" IN ('ASSESSOR', 'DEALER') AND b."valuedOn" >= today - max_age AND b."amountCents" > n."amountCents")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase is re-based by staff only once its valuation has aged out, on the highest current valuation, at its amount';
    END IF;
    IF NOT public."purchaseValuationOk"(NEW."tenantId", loan_row."assetId", NEW."purchaseValuationId", NEW."purchasePriceExclVatCents", NEW."electedById", max_age) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = format('A purchase is at least the asset''s market value: an assessor''s or dealer''s valuation of this asset dated within %s days, recorded by someone other than the elector', max_age);
    END IF;
  END IF;
  -- Notice ends an extension a month on (or at its last appended rental), given between the election and today.
  IF OLD."extensionNoticeOn" IS NULL AND NEW."extensionNoticeOn" IS NOT NULL
    AND NOT (NEW."extensionNoticeByClientId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."cpaApplies")) AND (
      NEW."outcome" <> 'EXTEND' OR NEW."extensionNoticeOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date
      OR NEW."extensionNoticeOn" > today OR NEW."extensionEndsOn" IS NULL
      -- On the first rental date (stepping a month at a time from the last rental, as the daily run appends
      -- them) at least a month after the notice and not before the billed period ends.
      OR (NEW."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" IS DISTINCT FROM (
        WITH RECURSIVE step(d, i) AS (
          SELECT MAX(r."dueDate"), 0 FROM "LeaseRental" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."cancelledAt" IS NULL
          UNION ALL SELECT (step.d + INTERVAL '1 month')::date, step.i + 1 FROM step WHERE step.i < 120)
        SELECT MIN(step.d) FROM step
        WHERE step.d >= GREATEST((NEW."extensionNoticeOn" + INTERVAL '1 month')::date, public."leaseTermEnd"(NEW."loanId", NEW."tenantId"))))) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Notice is given between the election and today, and ends the extension on the first rental date a month after it and after the billed period';
  END IF;
  IF OLD."extensionNoticeOn" IS NULL AND NEW."extensionNoticeOn" IS NOT NULL
    AND NEW."extensionNoticeByClientId" IS NOT NULL AND EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."cpaApplies")
    AND (NEW."extensionNoticeOn" > today OR (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date > NEW."extensionNoticeOn"
      OR NEW."extensionEndsOn" IS DISTINCT FROM public."recoveryAddBusinessDays"(NEW."extensionNoticeOn", 20)) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A CPA lessee ends continuation on 20 business days notice';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'ELECTED' AND NEW."status" = 'INSPECTED' AND NEW."outcome" = 'RETURN')
    OR (OLD."status" = 'EXTENDING' AND NEW."status" = 'INSPECTED' AND NEW."extensionEndsOn" IS NOT NULL AND NEW."extensionEndsOn" <= today)
    OR (OLD."status" = 'INSPECTED' AND NEW."status" = 'INVOICED')
    OR (OLD."status" = 'ELECTED' AND NEW."status" = 'INVOICED' AND NEW."outcome" = 'PURCHASE')
    OR (OLD."status" = 'INVOICED' AND NEW."status" = 'COMPLETED')
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A %s end of term cannot move from %s to %s', NEW."outcome", OLD."status", NEW."status");
  END IF;
  IF NEW."status" = 'INSPECTED' AND OLD."status" <> 'INSPECTED' THEN
    -- The asset is inspected once it comes back: when the term (or the extension) ends, or on the accepted termination's date.
    returns_on := CASE
      WHEN NEW."origin" = 'EARLY_TERMINATION' THEN (SELECT q."terminationDate" FROM "LeaseTerminationQuote" q
        WHERE q."loanId" = NEW."loanId" AND q."tenantId" = NEW."tenantId" AND (q."status" = 'ACCEPTED' OR q."cpaCancellation" OR q."totalLoss"))
      WHEN NEW."outcome" = 'EXTEND' THEN NEW."extensionEndsOn"
      ELSE public."leaseTermEnd"(NEW."loanId", NEW."tenantId") END;
    IF returns_on IS NULL OR NEW."inspectedOn" < returns_on OR NEW."inspectedOn" > today
       OR NEW."inspectedOn" < (NEW."electedAt" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A return is inspected from the day the asset comes back, after the election, never in the future';
    END IF;
    -- The final reading is this lease's asset's, taken at the inspection, and the latest.
    IF NEW."finalReadingId" IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM "AssetMeterReading" m WHERE m."id" = NEW."finalReadingId" AND m."tenantId" = NEW."tenantId"
          AND m."assetId" = loan_row."assetId" AND m."readingDate" = NEW."inspectedOn"
          AND NOT EXISTS (SELECT 1 FROM "AssetMeterReading" x WHERE x."tenantId" = m."tenantId" AND x."assetId" = m."assetId"
            AND x."unit" = m."unit" AND x."readingDate" > m."readingDate")) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The final reading is the lease''s asset''s latest, taken at the inspection';
    END IF;
  END IF;
  IF NEW."status" = 'INVOICED' AND OLD."status" = 'ELECTED' THEN
    -- A purchase is sold when the term ends, on a valuation still current.
    SELECT v."valuedOn" INTO valuation FROM "AssetValuation" v WHERE v."id" = NEW."purchaseValuationId" AND v."tenantId" = NEW."tenantId";
    IF today < public."leaseTermEnd"(NEW."loanId", NEW."tenantId") OR valuation."valuedOn" < today - max_age THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase is invoiced when the term ends, on a current valuation';
    END IF;
  END IF;
  IF NEW."status" = 'COMPLETED' THEN
    IF EXISTS (SELECT 1 FROM "RepaymentSchedule" r WHERE r."loanId" = NEW."loanId" AND r."tenantId" = NEW."tenantId" AND r."totalPaid" < r."totalDue") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An end of term completes once everything owed on the lease is paid';
    END IF;
    IF NEW."outcome" = 'PURCHASE' AND NULLIF(btrim(loan_row."registrationNumber"), '') IS NOT NULL AND NEW."natisTransferConfirmedAt" IS NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A purchase completes once the eNaTIS change of ownership is confirmed';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;

ALTER TABLE "LeaseTerminationQuote" DROP CONSTRAINT "LeaseTerminationQuote_termination_window";
ALTER TABLE "LeaseTerminationQuote" ADD CONSTRAINT "LeaseTerminationQuote_termination_window" CHECK (
 "lessorCancellation" OR "terminationDate" BETWEEN "quotedOn" AND "quotedOn" + 60
);

-- A credited future maintenance supply must not also be refunded by fund settlement.
ALTER TABLE "MaintenanceFundMovement" ADD COLUMN "creditedLeaseRentalId" TEXT;
CREATE UNIQUE INDEX "MaintenanceFundMovement_creditedLeaseRentalId_key" ON "MaintenanceFundMovement"("creditedLeaseRentalId");
CREATE UNIQUE INDEX "MaintenanceFundMovement_tenantId_creditedLeaseRentalId_key" ON "MaintenanceFundMovement"("tenantId", "creditedLeaseRentalId");
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_tenantId_creditedLeaseRentalId_fkey"
 FOREIGN KEY ("tenantId", "creditedLeaseRentalId") REFERENCES "LeaseRental"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "MaintenanceFundMovement" ADD CONSTRAINT "MaintenanceFundMovement_credit_shape" CHECK (
 ("kind" = 'CONTRIBUTION_CREDIT') = ("creditedLeaseRentalId" IS NOT NULL)
);
CREATE OR REPLACE FUNCTION public."guardMaintenanceFundMovement"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE ok BOOLEAN;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A maintenance fund movement is immutable';
  END IF;
  IF NEW."kind" = 'CONTRIBUTION' THEN
    SELECT EXISTS (SELECT 1 FROM "LeaseRental" r JOIN "MaintenanceFund" f ON f."loanId" = r."loanId" AND f."tenantId" = r."tenantId"
      WHERE r."id" = NEW."leaseRentalId" AND r."tenantId" = NEW."tenantId" AND f."id" = NEW."fundId" AND f."settledAt" IS NULL
        AND r."taxInvoiceId" IS NOT NULL AND r."maintenanceExclVatCents" = NEW."amountCents") INTO ok;
  ELSIF NEW."kind" = 'CONTRIBUTION_CREDIT' THEN
    SELECT EXISTS (SELECT 1 FROM "LeaseRental" r
      JOIN "MaintenanceFundMovement" original ON original."leaseRentalId" = r."id" AND original."tenantId" = r."tenantId" AND original."kind" = 'CONTRIBUTION'
      JOIN "MaintenanceFund" fund ON fund."id" = original."fundId" AND fund."tenantId" = original."tenantId"
      WHERE r."id" = NEW."creditedLeaseRentalId" AND r."tenantId" = NEW."tenantId" AND original."fundId" = NEW."fundId"
        AND original."amountCents" = NEW."amountCents" AND r."cancelledAt" IS NOT NULL AND r."cancellationCreditNoteId" IS NOT NULL
        AND fund."settledAt" IS NULL) INTO ok;
  ELSIF NEW."kind" = 'CLAIM' THEN
    SELECT EXISTS (SELECT 1 FROM "MaintenanceClaim" c JOIN "MaintenanceFund" f ON f."id" = c."fundId" AND f."tenantId" = c."tenantId"
      WHERE c."id" = NEW."claimId" AND c."tenantId" = NEW."tenantId" AND f."settledAt" IS NULL
      AND c."fundId" = NEW."fundId" AND c."status" = 'PAID' AND c."amountExclVatCents" = NEW."amountCents") INTO ok;
  ELSE
    -- A settlement: of an unsettled lessee-settled fund, settled in the same
    -- transaction (checkSettlementMovement); a billed deficit on an invoice of the fund's loan.
    SELECT EXISTS (SELECT 1 FROM "MaintenanceFund" f WHERE f."id" = NEW."fundId" AND f."tenantId" = NEW."tenantId"
      AND f."riskModel" = 'LESSEE_SETTLED' AND f."settledAt" IS NULL
      AND (NEW."kind" = 'SETTLEMENT_REFUND' OR EXISTS (SELECT 1 FROM "TaxInvoice" i WHERE i."id" = NEW."taxInvoiceId"
        AND i."tenantId" = NEW."tenantId" AND i."loanId" = f."loanId"))) INTO ok;
  END IF;
  IF NOT ok THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('A %s movement must be backed by its rental, paid claim or a lessee-settled fund''s settlement', NEW."kind");
  END IF;
  RETURN NEW;
END;
$function$;
