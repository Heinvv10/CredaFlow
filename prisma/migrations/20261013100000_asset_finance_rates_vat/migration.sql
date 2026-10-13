-- CreateEnum
CREATE TYPE "ReferenceRateBasis" AS ENUM ('FIXED', 'PRIME', 'REPO', 'JIBAR', 'ZARONIA', 'LENDER_BASE');

-- CreateEnum
CREATE TYPE "TaxDocumentKind" AS ENUM ('TAX_INVOICE', 'CREDIT_NOTE');

-- CreateTable
CREATE TABLE "ReferenceRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "basis" "ReferenceRateBasis" NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferenceRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContractRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "basis" "ReferenceRateBasis" NOT NULL,
    "margin" DECIMAL(9,6),
    "fixedRate" DECIMAL(9,6),
    "resultingRate" DECIMAL(9,6) NOT NULL,
    "newInstalmentCents" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContractRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VatConfig" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "vatNumber" TEXT NOT NULL,
    "registeredName" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VatConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VatRate" (
    "id" TEXT NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "rate" DECIMAL(6,4) NOT NULL,

    CONSTRAINT "VatRate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxDocumentCounter" (
    "tenantId" TEXT NOT NULL,
    "kind" "TaxDocumentKind" NOT NULL,
    "next" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "TaxDocumentCounter_pkey" PRIMARY KEY ("tenantId","kind")
);

-- CreateTable
CREATE TABLE "TaxInvoice" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "invoiceNumber" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "supplyDate" DATE NOT NULL,
    "loanId" TEXT,
    "supplierName" TEXT NOT NULL,
    "supplierAddress" TEXT NOT NULL,
    "supplierVatNumber" TEXT NOT NULL,
    "recipientName" TEXT NOT NULL,
    "recipientAddress" TEXT NOT NULL,
    "recipientVatNumber" TEXT,
    "vatRate" DECIMAL(6,4) NOT NULL,
    "totalExclVatCents" INTEGER NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "totalInclVatCents" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TaxInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TaxInvoiceLine" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNo" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 1,
    "unitExclVatCents" INTEGER NOT NULL,
    "exclVatCents" INTEGER NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "inclVatCents" INTEGER NOT NULL,

    CONSTRAINT "TaxInvoiceLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CreditNote" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "creditNoteNumber" TEXT NOT NULL,
    "issueDate" DATE NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "exclVatCents" INTEGER NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "inclVatCents" INTEGER NOT NULL,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CreditNote_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ReferenceRate_tenantId_basis_effectiveDate_key" ON "ReferenceRate"("tenantId", "basis", "effectiveDate");

-- CreateIndex
CREATE INDEX "ContractRate_tenantId_idx" ON "ContractRate"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "ContractRate_loanId_effectiveDate_key" ON "ContractRate"("loanId", "effectiveDate");

-- CreateIndex
CREATE UNIQUE INDEX "VatConfig_tenantId_key" ON "VatConfig"("tenantId");

-- CreateIndex
CREATE UNIQUE INDEX "VatRate_effectiveDate_key" ON "VatRate"("effectiveDate");

-- CreateIndex
CREATE INDEX "TaxInvoice_loanId_idx" ON "TaxInvoice"("loanId");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoice_tenantId_number_key" ON "TaxInvoice"("tenantId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "TaxInvoiceLine_invoiceId_lineNo_key" ON "TaxInvoiceLine"("invoiceId", "lineNo");

-- CreateIndex
CREATE UNIQUE INDEX "CreditNote_tenantId_number_key" ON "CreditNote"("tenantId", "number");

-- AddForeignKey
ALTER TABLE "ReferenceRate" ADD CONSTRAINT "ReferenceRate_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContractRate" ADD CONSTRAINT "ContractRate_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VatConfig" ADD CONSTRAINT "VatConfig_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxDocumentCounter" ADD CONSTRAINT "TaxDocumentCounter_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_loanId_fkey" FOREIGN KEY ("loanId") REFERENCES "Loan"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TaxInvoiceLine" ADD CONSTRAINT "TaxInvoiceLine_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TaxInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "TaxInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------
-- Hand-written (VAT and tax invoices, docs/asset-finance/DESIGN.md D7)
-- ---------------------------------------------------------------------------

-- The standard VAT rate: 15% from 1 April 2018. National, not per tenant.
INSERT INTO "VatRate" ("id", "effectiveDate", "rate") VALUES ('vat_rate_2018_04_01', '2018-04-01', 0.1500) ON CONFLICT DO NOTHING;

ALTER TABLE "VatRate" ADD CONSTRAINT "VatRate_rate_range" CHECK ("rate" >= 0 AND "rate" < 1);
ALTER TABLE "TaxDocumentCounter" ADD CONSTRAINT "TaxDocumentCounter_next_positive" CHECK ("next" >= 1);

ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_number_positive" CHECK ("number" > 0);
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_vat_rate_range" CHECK ("vatRate" >= 0 AND "vatRate" < 1);
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_amounts_non_negative" CHECK ("totalExclVatCents" >= 0 AND "vatCents" >= 0 AND "totalInclVatCents" >= 0);
ALTER TABLE "TaxInvoice" ADD CONSTRAINT "TaxInvoice_total_adds_up" CHECK ("totalInclVatCents" = "totalExclVatCents" + "vatCents");

-- A line has a positive value, so a line added after issue always changes the
-- sum the deferred totals check compares (below).
ALTER TABLE "TaxInvoiceLine" ADD CONSTRAINT "TaxInvoiceLine_line_no_positive" CHECK ("lineNo" >= 1);
ALTER TABLE "TaxInvoiceLine" ADD CONSTRAINT "TaxInvoiceLine_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "TaxInvoiceLine" ADD CONSTRAINT "TaxInvoiceLine_unit_positive" CHECK ("unitExclVatCents" > 0);
ALTER TABLE "TaxInvoiceLine" ADD CONSTRAINT "TaxInvoiceLine_vat_non_negative" CHECK ("vatCents" >= 0);
ALTER TABLE "TaxInvoiceLine" ADD CONSTRAINT "TaxInvoiceLine_extension" CHECK ("exclVatCents" = "quantity" * "unitExclVatCents");
ALTER TABLE "TaxInvoiceLine" ADD CONSTRAINT "TaxInvoiceLine_total_adds_up" CHECK ("inclVatCents" = "exclVatCents" + "vatCents");
ALTER TABLE "TaxInvoiceLine" ADD CONSTRAINT "TaxInvoiceLine_description_not_blank" CHECK (btrim("description") <> '');

ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_number_positive" CHECK ("number" > 0);
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_amounts_positive" CHECK ("exclVatCents" > 0 AND "vatCents" >= 0 AND "inclVatCents" > 0);
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_total_adds_up" CHECK ("inclVatCents" = "exclVatCents" + "vatCents");
ALTER TABLE "CreditNote" ADD CONSTRAINT "CreditNote_reason_not_blank" CHECK (btrim("reason") <> '');

-- Issued tax documents are immutable: a correction is a CreditNote, never an
-- edit. Row-level for UPDATE/DELETE, statement-level for TRUNCATE.
CREATE OR REPLACE FUNCTION public."refuseTaxDocumentChange"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION USING
    ERRCODE = '23514',
    MESSAGE = format('%s is immutable once issued: %s refused (issue a credit note instead)', TG_TABLE_NAME, TG_OP);
END;
$function$;

CREATE TRIGGER "TaxInvoice_immutable" BEFORE UPDATE OR DELETE ON "TaxInvoice" FOR EACH ROW EXECUTE FUNCTION "refuseTaxDocumentChange"();
CREATE TRIGGER "TaxInvoice_no_truncate" BEFORE TRUNCATE ON "TaxInvoice" FOR EACH STATEMENT EXECUTE FUNCTION "refuseTaxDocumentChange"();
CREATE TRIGGER "TaxInvoiceLine_immutable" BEFORE UPDATE OR DELETE ON "TaxInvoiceLine" FOR EACH ROW EXECUTE FUNCTION "refuseTaxDocumentChange"();
CREATE TRIGGER "TaxInvoiceLine_no_truncate" BEFORE TRUNCATE ON "TaxInvoiceLine" FOR EACH STATEMENT EXECUTE FUNCTION "refuseTaxDocumentChange"();
CREATE TRIGGER "CreditNote_immutable" BEFORE UPDATE OR DELETE ON "CreditNote" FOR EACH ROW EXECUTE FUNCTION "refuseTaxDocumentChange"();
CREATE TRIGGER "CreditNote_no_truncate" BEFORE TRUNCATE ON "CreditNote" FOR EACH STATEMENT EXECUTE FUNCTION "refuseTaxDocumentChange"();

-- Gap-free numbering. The counter row is taken by one upsert: it row-locks
-- (tenantId, kind) until the issuing transaction ends, so concurrent issuers
-- queue, and a rolled-back issue rolls the counter back with it. A sequence
-- would not do: nextval is never rolled back, so an abort leaves a gap.
CREATE OR REPLACE FUNCTION public."nextTaxDocumentNumber"(tenant_id TEXT, doc_kind "TaxDocumentKind")
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  issued INTEGER;
BEGIN
  INSERT INTO "TaxDocumentCounter" ("tenantId", "kind", "next")
  VALUES (tenant_id, doc_kind, 2)
  ON CONFLICT ("tenantId", "kind") DO UPDATE SET "next" = "TaxDocumentCounter"."next" + 1
  RETURNING "next" - 1 INTO issued;
  RETURN issued;
END;
$function$;

-- The trigger ASSIGNS the number and display number; whatever the client
-- supplied for "number" / "invoiceNumber" is overwritten. Six digits minimum,
-- never truncated.
CREATE OR REPLACE FUNCTION public."assignTaxInvoiceNumber"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  NEW."number" := "nextTaxDocumentNumber"(NEW."tenantId", 'TAX_INVOICE');
  NEW."invoiceNumber" := 'INV-' || lpad(NEW."number"::text, greatest(6, length(NEW."number"::text)), '0');
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "TaxInvoice_assign_number" BEFORE INSERT ON "TaxInvoice" FOR EACH ROW EXECUTE FUNCTION "assignTaxInvoiceNumber"();

-- Same for credit notes, which also must belong to the invoice's tenant and
-- may never credit more than the invoice charged. The cap is checked after
-- the counter lock is taken, so concurrent credit notes see each other.
CREATE OR REPLACE FUNCTION public."assignCreditNoteNumber"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  invoice RECORD;
  credited RECORD;
BEGIN
  NEW."number" := "nextTaxDocumentNumber"(NEW."tenantId", 'CREDIT_NOTE');
  NEW."creditNoteNumber" := 'CN-' || lpad(NEW."number"::text, greatest(6, length(NEW."number"::text)), '0');

  SELECT i."tenantId", i."totalExclVatCents", i."vatCents" INTO invoice
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
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "CreditNote_assign_number" BEFORE INSERT ON "CreditNote" FOR EACH ROW EXECUTE FUNCTION "assignCreditNoteNumber"();

-- An invoice's totals equal the sum of its lines, and it has at least one
-- line. Lines are inserted in the invoice's own transaction, so the check is
-- deferred to commit; it fires for the invoice and for every line, so a line
-- added to an issued invoice later also fails it.
CREATE OR REPLACE FUNCTION public."checkTaxInvoiceTotals"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  invoice_id TEXT;
  totals RECORD;
BEGIN
  IF TG_TABLE_NAME = 'TaxInvoice' THEN
    invoice_id := NEW."id";
  ELSE
    invoice_id := NEW."invoiceId";
  END IF;

  SELECT i."invoiceNumber", i."totalExclVatCents", i."vatCents", i."totalInclVatCents",
         count(l."id") AS lines,
         coalesce(sum(l."exclVatCents"), 0) AS excl,
         coalesce(sum(l."vatCents"), 0) AS vat,
         coalesce(sum(l."inclVatCents"), 0) AS incl
  INTO totals
  FROM "TaxInvoice" AS i
  LEFT JOIN "TaxInvoiceLine" AS l ON l."invoiceId" = i."id"
  WHERE i."id" = invoice_id
  GROUP BY i."id";

  IF totals.lines = 0
     OR totals."totalExclVatCents" <> totals.excl
     OR totals."vatCents" <> totals.vat
     OR totals."totalInclVatCents" <> totals.incl THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('Tax invoice %s totals must equal the sum of its lines (and it must have one)', totals."invoiceNumber");
  END IF;
  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER "TaxInvoice_totals_match_lines" AFTER INSERT ON "TaxInvoice" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "checkTaxInvoiceTotals"();
CREATE CONSTRAINT TRIGGER "TaxInvoiceLine_totals_match_lines" AFTER INSERT ON "TaxInvoiceLine" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "checkTaxInvoiceTotals"();
