-- VAT Act s21: an increase in consideration is a debit note linked to the
-- original supply. Existing immutable tax documents retain all their fields.
ALTER TABLE "TaxInvoice" ADD COLUMN "adjustmentKind" TEXT, ADD COLUMN "adjustmentReason" TEXT, ADD COLUMN "adjustedInvoiceId" TEXT;
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_adjustedInvoice_fkey" FOREIGN KEY ("tenantId", "adjustedInvoiceId") REFERENCES "TaxInvoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_adjustment_check" CHECK (("adjustmentKind" IS NULL AND "adjustedInvoiceId" IS NULL AND "adjustmentReason" IS NULL) OR ("adjustmentKind" = 'DEBIT_NOTE' AND "adjustedInvoiceId" IS NOT NULL AND "adjustmentReason" IS NOT NULL AND length(trim("adjustmentReason")) > 0));
ALTER TABLE "AssetFinanceRateNotice" ADD COLUMN "taxDocuments" JSONB;
CREATE FUNCTION public."validateRateDebitNote"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE original "TaxInvoice"%ROWTYPE;
BEGIN
 IF NEW."adjustmentKind" IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO original FROM "TaxInvoice" WHERE "tenantId" = NEW."tenantId" AND id = NEW."adjustedInvoiceId";
 IF NOT FOUND OR original."adjustmentKind" IS NOT NULL OR NEW."vatRate" <> original."vatRate" OR NEW."supplyDate" <> original."supplyDate" OR NEW."loanId" IS DISTINCT FROM original."loanId"
 OR ROW(NEW."supplierName",NEW."supplierAddress",NEW."supplierVatNumber",NEW."recipientName",NEW."recipientAddress",NEW."recipientVatNumber") IS DISTINCT FROM ROW(original."supplierName",original."supplierAddress",original."supplierVatNumber",original."recipientName",original."recipientAddress",original."recipientVatNumber") THEN RAISE EXCEPTION 'Debit note must identify its original supply and parties'; END IF;
 NEW."invoiceNumber" := 'DN-' || lpad(NEW.number::text, 6, '0');
 RETURN NEW;
END $$;
CREATE TRIGGER "TaxInvoice_z_debit_note" BEFORE INSERT ON "TaxInvoice" FOR EACH ROW EXECUTE FUNCTION public."validateRateDebitNote"();
