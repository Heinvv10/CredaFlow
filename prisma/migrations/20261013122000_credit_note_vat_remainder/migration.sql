-- A partial credit cannot carry more VAT than the invoice has left. Per-line
-- invoice rounding can make that remainder one cent lower than VAT calculated
-- on the aggregate credit value.
CREATE OR REPLACE FUNCTION public."assignCreditNoteNumber"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  invoice RECORD;
  credited RECORD;
  expected_vat BIGINT;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('tax-doc:' || NEW."tenantId" || ':CREDIT_NOTE', 0));
  SELECT coalesce(max(c."number"), 0) + 1 INTO NEW."number" FROM "CreditNote" AS c WHERE c."tenantId" = NEW."tenantId";
  NEW."creditNoteNumber" := 'CN-' || lpad(NEW."number"::text, greatest(6, length(NEW."number"::text)), '0');

  SELECT i."tenantId", i."totalExclVatCents", i."vatCents", i."vatRate" INTO invoice
  FROM "TaxInvoice" AS i WHERE i."id" = NEW."invoiceId";
  IF NOT FOUND OR invoice."tenantId" <> NEW."tenantId" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Credit note must reference a tax invoice of the same tenant';
  END IF;

  SELECT coalesce(sum(c."exclVatCents"), 0) AS excl, coalesce(sum(c."vatCents"), 0) AS vat INTO credited
  FROM "CreditNote" AS c WHERE c."invoiceId" = NEW."invoiceId";
  IF credited.excl + NEW."exclVatCents" > invoice."totalExclVatCents"
     OR credited.vat + NEW."vatCents" > invoice."vatCents" THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Credit notes may not exceed the value or VAT of the tax invoice they credit';
  END IF;

  expected_vat := least(
    "vatHalfUpCents"(NEW."exclVatCents", invoice."vatRate"),
    invoice."vatCents" - credited.vat
  );
  IF credited.excl + NEW."exclVatCents" = invoice."totalExclVatCents" THEN
    expected_vat := invoice."vatCents" - credited.vat;
  END IF;
  IF NEW."vatCents" <> expected_vat THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A credit note''s VAT must be the invoice rate applied half-up, capped at the remaining invoice VAT';
  END IF;
  RETURN NEW;
END;
$function$;
