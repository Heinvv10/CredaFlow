-- CreateEnum
CREATE TYPE "ReferenceRateBasis" AS ENUM ('FIXED', 'PRIME', 'REPO', 'JIBAR', 'ZARONIA', 'LENDER_BASE');

-- CreateEnum
CREATE TYPE "TaxDocumentKind" AS ENUM ('TAX_INVOICE', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "ReferenceRateStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- CreateTable
CREATE TABLE "ReferenceRate" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "basis" "ReferenceRateBasis" NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "rate" DECIMAL(9,6) NOT NULL,
    "status" "ReferenceRateStatus" NOT NULL DEFAULT 'PENDING',
    "requestedById" TEXT NOT NULL,
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
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
CREATE INDEX "ReferenceRate_tenantId_basis_effectiveDate_idx" ON "ReferenceRate"("tenantId", "basis", "effectiveDate");

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

-- ---------------------------------------------------------------------------
-- Reference rates: four-eyes (docs/asset-finance/DESIGN.md D4)
-- ---------------------------------------------------------------------------
-- A value is recorded PENDING by one user and APPROVED or REJECTED by another;
-- only APPROVED values reprice loans (lib/asset-finance/rates-store.ts).

-- One live value per tenant, basis and date. A REJECTED value does not block
-- its correction. (Partial, so it is not in schema.prisma; Prisma reports a
-- violation as P2002 like any unique index.)
CREATE UNIQUE INDEX "ReferenceRate_live_key" ON "ReferenceRate"("tenantId", "basis", "effectiveDate") WHERE "status" <> 'REJECTED';

-- Sanity band: an annual nominal decimal above 0% and below 50%.
ALTER TABLE "ReferenceRate" ADD CONSTRAINT "ReferenceRate_rate_band" CHECK ("rate" > 0 AND "rate" < 0.5);
-- PENDING has no decision; a decided value has both who and when.
ALTER TABLE "ReferenceRate" ADD CONSTRAINT "ReferenceRate_decision_shape" CHECK (
  ("status" = 'PENDING') = ("decidedById" IS NULL) AND ("decidedById" IS NULL) = ("decidedAt" IS NULL)
);
-- The decider is never the requester.
ALTER TABLE "ReferenceRate" ADD CONSTRAINT "ReferenceRate_four_eyes" CHECK ("decidedById" IS NULL OR "decidedById" <> "requestedById");

-- What was recorded never changes; the only UPDATE is the one decision on a
-- PENDING row, after which the row is immutable. An APPROVED value is never
-- deleted (repricings and audit rows cite it); TRUNCATE is refused outright.
CREATE OR REPLACE FUNCTION public."guardReferenceRateLifecycle"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'ReferenceRate rows are never truncated';
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'APPROVED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An approved reference rate is never deleted';
    END IF;
    RETURN OLD;
  END IF;
  IF NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
     OR NEW."basis" IS DISTINCT FROM OLD."basis"
     OR NEW."effectiveDate" IS DISTINCT FROM OLD."effectiveDate"
     OR NEW."rate" IS DISTINCT FROM OLD."rate"
     OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
     OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A reference rate''s value, basis, date, tenant and requester never change';
  END IF;
  IF OLD."status" <> 'PENDING' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A %s reference rate is immutable', OLD."status");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "ReferenceRate_guard_lifecycle" BEFORE UPDATE OR DELETE ON "ReferenceRate" FOR EACH ROW EXECUTE FUNCTION "guardReferenceRateLifecycle"();
CREATE TRIGGER "ReferenceRate_no_truncate" BEFORE TRUNCATE ON "ReferenceRate" FOR EACH STATEMENT EXECUTE FUNCTION "guardReferenceRateLifecycle"();

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
--
-- Only the TaxInvoice / CreditNote insert triggers may take a number: a call
-- outside a trigger (pg_trigger_depth() = 0) is refused, so a number can
-- never be burnt by a stray SELECT. The function raises the transaction-local
-- flag credaflow.tax_numbering for its own write and lowers it again; the
-- counter's guard (below) refuses every write made without it.
CREATE OR REPLACE FUNCTION public."nextTaxDocumentNumber"(tenant_id TEXT, doc_kind "TaxDocumentKind")
 RETURNS integer
 LANGUAGE plpgsql
AS $function$
DECLARE
  issued INTEGER;
BEGIN
  IF pg_trigger_depth() = 0 THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'nextTaxDocumentNumber is called only by the tax invoice and credit note insert triggers';
  END IF;
  PERFORM set_config('credaflow.tax_numbering', 'on', true);
  INSERT INTO "TaxDocumentCounter" ("tenantId", "kind", "next")
  VALUES (tenant_id, doc_kind, 2)
  ON CONFLICT ("tenantId", "kind") DO UPDATE SET "next" = "TaxDocumentCounter"."next" + 1
  RETURNING "next" - 1 INTO issued;
  PERFORM set_config('credaflow.tax_numbering', 'off', true);
  RETURN issued;
END;
$function$;

-- Only nextTaxDocumentNumber writes the counter: INSERT and UPDATE need its
-- flag; DELETE (which would restart numbering) and TRUNCATE are refused.
CREATE OR REPLACE FUNCTION public."guardTaxDocumentCounter"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE')
     OR current_setting('credaflow.tax_numbering', true) IS DISTINCT FROM 'on' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('TaxDocumentCounter is written only by nextTaxDocumentNumber: %s refused', TG_OP);
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "TaxDocumentCounter_guard" BEFORE INSERT OR UPDATE OR DELETE ON "TaxDocumentCounter" FOR EACH ROW EXECUTE FUNCTION "guardTaxDocumentCounter"();
CREATE TRIGGER "TaxDocumentCounter_no_truncate" BEFORE TRUNCATE ON "TaxDocumentCounter" FOR EACH STATEMENT EXECUTE FUNCTION "guardTaxDocumentCounter"();

-- VAT arithmetic, the same integer half-up formulas as lib/vat/amounts.ts. A
-- rate is DECIMAL(6,4), so rate × 10000 is an exact integer (ten-thousandths).
--   vatHalfUpCents(excl, rate)       = vatOnExclusive: floor((2·excl·r + 10000) / 20000)
--   exclOfInclusiveCents(incl, rate) = splitInclusive's exclusive part:
--                                      floor((2·incl·10000 + (10000 + r)) / (2·(10000 + r)))
-- All operands are non-negative, so integer division is floor.
CREATE OR REPLACE FUNCTION public."vatHalfUpCents"(excl_cents BIGINT, rate NUMERIC)
 RETURNS BIGINT
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT (2 * excl_cents * (rate * 10000)::BIGINT + 10000) / 20000
$function$;

CREATE OR REPLACE FUNCTION public."exclOfInclusiveCents"(incl_cents BIGINT, rate NUMERIC)
 RETURNS BIGINT
 LANGUAGE sql
 IMMUTABLE
AS $function$
  SELECT (2 * incl_cents * 10000 + (10000 + (rate * 10000)::BIGINT)) / (2 * (10000 + (rate * 10000)::BIGINT))
$function$;

-- A line's VAT is consistent with the invoice's rate, by one of the two
-- half-up methods lib/vat/amounts.ts implements: VAT on the exclusive value
-- (a line priced exclusive), or the tax-fraction split of the inclusive value
-- (a line priced inclusive, e.g. the instalment-sale cash price, so exclusive +
-- VAT equals that price to the cent; ~13% of inclusive amounts at 15% have no
-- exclusive value whose VAT adds back to them exactly).
CREATE OR REPLACE FUNCTION public."checkTaxInvoiceLineVat"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  invoice_rate NUMERIC;
BEGIN
  SELECT i."vatRate" INTO invoice_rate FROM "TaxInvoice" AS i WHERE i."id" = NEW."invoiceId";
  IF invoice_rate IS NULL
     OR NOT (NEW."vatCents" = "vatHalfUpCents"(NEW."exclVatCents", invoice_rate)
             OR NEW."exclVatCents" = "exclOfInclusiveCents"(NEW."inclVatCents", invoice_rate)) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A tax invoice line''s VAT must be the invoice rate applied half-up to its exclusive value, or the tax fraction of its inclusive value';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "TaxInvoiceLine_vat_matches_rate" BEFORE INSERT ON "TaxInvoiceLine" FOR EACH ROW EXECUTE FUNCTION "checkTaxInvoiceLineVat"();

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

  -- VAT proportional to the invoice, by creditNoteVat's rule: the note that
  -- credits the whole remaining value credits exactly the remaining VAT (which
  -- absorbs the invoice's per-line rounding); any other note's VAT is the
  -- invoice rate applied half-up to its value.
  IF credited.excl + NEW."exclVatCents" = invoice."totalExclVatCents" THEN
    IF NEW."vatCents" <> invoice."vatCents" - credited.vat THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A credit note for the whole remaining value must credit exactly the remaining VAT';
    END IF;
  ELSIF NEW."vatCents" <> "vatHalfUpCents"(NEW."exclVatCents", invoice."vatRate") THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A credit note''s VAT must be the invoice rate applied half-up to its value';
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
