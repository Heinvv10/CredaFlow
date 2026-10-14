-- CreateEnum
CREATE TYPE "RentalTiming" AS ENUM ('ADVANCE', 'ARREARS');

-- CreateEnum
CREATE TYPE "MaintenanceRiskModel" AS ENUM ('LENDER_RISK', 'LESSEE_SETTLED');

-- CreateEnum
CREATE TYPE "UsageUnit" AS ENUM ('HOURS', 'KM');

-- AlterTable
ALTER TABLE "AssetFinanceDeal" ADD COLUMN     "cpaApplies" BOOLEAN,
ADD COLUMN     "cpaEvidenceIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "cpaRule" TEXT,
ADD COLUMN     "earlyTerminationPenaltyRate" DECIMAL(9,6),
ADD COLUMN     "escalationRate" DECIMAL(9,6),
ADD COLUMN     "excessRateCents" INTEGER,
ADD COLUMN     "maintenanceEscalationRate" DECIMAL(9,6),
ADD COLUMN     "maintenanceMonthlyExclVatCents" INTEGER,
ADD COLUMN     "maintenanceRiskModel" "MaintenanceRiskModel",
ADD COLUMN     "rentalTiming" "RentalTiming",
ADD COLUMN     "usageAllowancePerYear" INTEGER,
ADD COLUMN     "usageUnit" "UsageUnit";

-- AlterTable
ALTER TABLE "FinancedAsset" ADD COLUMN     "natisOwner" TEXT;

-- AlterTable
ALTER TABLE "Loan" ADD COLUMN     "cpaApplies" BOOLEAN,
ADD COLUMN     "cpaRule" TEXT;

-- CreateTable
CREATE TABLE "LeaseRental" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "loanId" TEXT NOT NULL,
    "scheduleId" TEXT NOT NULL,
    "periodNo" INTEGER NOT NULL,
    "dueDate" DATE NOT NULL,
    "rentalExclVatCents" INTEGER NOT NULL,
    "maintenanceExclVatCents" INTEGER NOT NULL,
    "vatCents" INTEGER NOT NULL,
    "totalCents" INTEGER NOT NULL,
    "vatRate" DECIMAL(6,4) NOT NULL,
    "taxInvoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeaseRental_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LeaseRental_scheduleId_key" ON "LeaseRental"("scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseRental_taxInvoiceId_key" ON "LeaseRental"("taxInvoiceId");

-- CreateIndex
CREATE INDEX "LeaseRental_tenantId_dueDate_idx" ON "LeaseRental"("tenantId", "dueDate");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseRental_tenantId_id_key" ON "LeaseRental"("tenantId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseRental_tenantId_scheduleId_key" ON "LeaseRental"("tenantId", "scheduleId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseRental_tenantId_taxInvoiceId_key" ON "LeaseRental"("tenantId", "taxInvoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "LeaseRental_loanId_periodNo_key" ON "LeaseRental"("loanId", "periodNo");

-- CreateIndex
CREATE UNIQUE INDEX "RepaymentSchedule_tenantId_id_key" ON "RepaymentSchedule"("tenantId", "id");

-- AddForeignKey
ALTER TABLE "LeaseRental" ADD CONSTRAINT "LeaseRental_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeaseRental" ADD CONSTRAINT "LeaseRental_tenantId_loanId_fkey" FOREIGN KEY ("tenantId", "loanId") REFERENCES "Loan"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaseRental" ADD CONSTRAINT "LeaseRental_tenantId_scheduleId_fkey" FOREIGN KEY ("tenantId", "scheduleId") REFERENCES "RepaymentSchedule"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "LeaseRental" ADD CONSTRAINT "LeaseRental_tenantId_taxInvoiceId_fkey" FOREIGN KEY ("tenantId", "taxInvoiceId") REFERENCES "TaxInvoice"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;


-- ===========================================================================
-- Hand-written: operating and full-maintenance leases (slice 3, C1 and C3).
-- docs/asset-finance/DESIGN.md "Slice 3"; lib/asset-finance/lease-*.ts.
-- Every rule below has a RUN_ASSET_FINANCE_LEASE_IT case
-- (lib/asset-finance/lease-foundation.integration.test.ts).
-- ===========================================================================

-- A deal's lease terms. A lease (OPERATING_LEASE, FULL_MAINTENANCE_LEASE) has
-- its rental timing, escalation, early-termination penalty and CPA scope; it
-- has no deposit, trade-in, financed fee or VAT deferral (the capital is the
-- cash price ex VAT). A full-maintenance lease also has its maintenance
-- amount, escalation and fund risk model, and contracted usage; an operating
-- lease has no maintenance and contracted usage is optional (all or none).
-- No other contract type carries any lease column.
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_lease_terms_shape" CHECK (
  ("contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) = ("rentalTiming" IS NOT NULL)
  AND ("contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) = ("escalationRate" IS NOT NULL)
  AND ("contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) = ("earlyTerminationPenaltyRate" IS NOT NULL)
  AND ("contractType" = 'FULL_MAINTENANCE_LEASE') = ("maintenanceMonthlyExclVatCents" IS NOT NULL)
  AND ("contractType" = 'FULL_MAINTENANCE_LEASE') = ("maintenanceEscalationRate" IS NOT NULL)
  AND ("contractType" = 'FULL_MAINTENANCE_LEASE') = ("maintenanceRiskModel" IS NOT NULL)
  AND num_nonnulls("usageAllowancePerYear", "usageUnit", "excessRateCents") IN (0, 3)
  AND ("contractType" <> 'FULL_MAINTENANCE_LEASE' OR "usageAllowancePerYear" IS NOT NULL)
  AND ("contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') OR "usageAllowancePerYear" IS NULL)
  AND ("contractType" NOT IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') OR (
    "depositCents" = 0 AND "tradeInCents" = 0 AND "financedFeesCents" = 0 AND "vatDeferralPeriodIndex" IS NULL
  ))
);
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_lease_terms_range" CHECK (
  ("escalationRate" IS NULL OR ("escalationRate" >= 0 AND "escalationRate" < 1))
  AND ("maintenanceEscalationRate" IS NULL OR ("maintenanceEscalationRate" >= 0 AND "maintenanceEscalationRate" < 1))
  AND ("earlyTerminationPenaltyRate" IS NULL OR ("earlyTerminationPenaltyRate" >= 0 AND "earlyTerminationPenaltyRate" < 1))
  AND ("maintenanceMonthlyExclVatCents" IS NULL OR "maintenanceMonthlyExclVatCents" > 0)
  AND ("usageAllowancePerYear" IS NULL OR "usageAllowancePerYear" > 0)
  AND ("excessRateCents" IS NULL OR "excessRateCents" > 0)
);

-- The Consumer Protection Act scope (lib/asset-finance/cpa-scope.ts
-- CPA_RULE_IDS) is snapshotted on every lease deal and its loan, and on
-- nothing else.
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_cpa_scope_shape" CHECK (
  ("contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) = ("cpaApplies" IS NOT NULL)
  AND ("contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) = ("cpaRule" IS NOT NULL)
  AND ("cpaRule" IS NULL OR "cpaRule" IN ('CPA_NATURAL_PERSON', 'CPA_FINANCIALS_UNPROVEN', 'CPA_JURISTIC_OVER_THRESHOLD', 'CPA_JURISTIC_UNDER_THRESHOLD'))
  AND ("cpaRule" IS NULL OR "cpaApplies" IS NOT DISTINCT FROM ("cpaRule" <> 'CPA_JURISTIC_OVER_THRESHOLD'))
  AND ("cpaRule" IS NOT NULL OR COALESCE("cpaEvidenceIds", ARRAY[]::TEXT[]) = ARRAY[]::TEXT[])
);
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_cpa_scope_shape" CHECK (
  ("contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) = ("cpaApplies" IS NOT NULL)
  AND ("contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) = ("cpaRule" IS NOT NULL)
  AND ("cpaRule" IS NULL OR "cpaRule" IN ('CPA_NATURAL_PERSON', 'CPA_FINANCIALS_UNPROVEN', 'CPA_JURISTIC_OVER_THRESHOLD', 'CPA_JURISTIC_UNDER_THRESHOLD'))
  AND ("cpaRule" IS NULL OR "cpaApplies" IS NOT DISTINCT FROM ("cpaRule" <> 'CPA_JURISTIC_OVER_THRESHOLD'))
);
-- A loan's CPA scope is its deal's, fixed at booking.
CREATE OR REPLACE FUNCTION public."guardLoanCpaScope"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."cpaApplies" IS DISTINCT FROM OLD."cpaApplies" OR NEW."cpaRule" IS DISTINCT FROM OLD."cpaRule" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease loan''s CPA scope is fixed at booking';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Loan_cpa_scope_fixed" BEFORE UPDATE OF "cpaApplies", "cpaRule" ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION public."guardLoanCpaScope"();

-- An ADVANCE lease commences on its first rental's due date (the rental is
-- paid in advance on the commencement date); every other deal starts before
-- its first instalment. Replaces the slice-1 CHECK of the same name.
ALTER TABLE "AssetFinanceDeal" DROP CONSTRAINT "AssetFinanceDeal_planned_start_before_first_due";
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_planned_start_before_first_due" CHECK (
  "plannedStartDate" IS NULL
  OR ("rentalTiming" IS DISTINCT FROM 'ADVANCE' AND "plannedStartDate" < "firstDueDate")
  OR ("rentalTiming" IS NOT DISTINCT FROM 'ADVANCE' AND "plannedStartDate" = "firstDueDate")
);

-- What was approved is what is signed and booked (slice-1 rule), now
-- including the lease terms and the CPA scope.
CREATE OR REPLACE FUNCTION public."freezeApprovedLeaseTerms"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF OLD."status" IN ('APPROVED', 'CONTRACTED') AND (
    NEW."clientId" IS DISTINCT FROM OLD."clientId"
    OR NEW."rentalTiming" IS DISTINCT FROM OLD."rentalTiming"
    OR NEW."escalationRate" IS DISTINCT FROM OLD."escalationRate"
    OR NEW."maintenanceMonthlyExclVatCents" IS DISTINCT FROM OLD."maintenanceMonthlyExclVatCents"
    OR NEW."maintenanceEscalationRate" IS DISTINCT FROM OLD."maintenanceEscalationRate"
    OR NEW."maintenanceRiskModel" IS DISTINCT FROM OLD."maintenanceRiskModel"
    OR NEW."usageAllowancePerYear" IS DISTINCT FROM OLD."usageAllowancePerYear"
    OR NEW."usageUnit" IS DISTINCT FROM OLD."usageUnit"
    OR NEW."excessRateCents" IS DISTINCT FROM OLD."excessRateCents"
    OR NEW."earlyTerminationPenaltyRate" IS DISTINCT FROM OLD."earlyTerminationPenaltyRate"
    OR NEW."cpaApplies" IS DISTINCT FROM OLD."cpaApplies"
    OR NEW."cpaRule" IS DISTINCT FROM OLD."cpaRule"
    OR NEW."cpaEvidenceIds" IS DISTINCT FROM OLD."cpaEvidenceIds"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An approved deal''s lessee, lease terms and CPA scope are what was approved: they are fixed';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "AssetFinanceDeal_approved_lease_terms_frozen" BEFORE UPDATE ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."freezeApprovedLeaseTerms"();

-- ---------------------------------------------------------------------------
-- NCA regime of a lease. An operating or full-maintenance lease is not a
-- credit agreement (ownership never passes), so its application is NON_NCA
-- with rule LEASE_NOT_CREDIT_AGREEMENT from the moment it is written, for an
-- entity or a sole-proprietor (Client) lessee alike. UNTESTED: legal.
-- The rule is bound both ways to the deal's contract type (checked at
-- commit), cannot be set or dropped by an update, and implies NON_NCA.
-- ---------------------------------------------------------------------------
ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_nca_classification_rule_known";
-- The classifier's ids (NCA_RULE_IDS, held equal by nca-rule-ids.test.ts),
-- or the lease rule, which is not a classifier result. An override's
-- approved rule (NcaRegimeOverride_approved_classification_rule_known) stays
-- the classifier's ids only: a lease's regime is never moved by an override.
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_nca_classification_rule_known" CHECK (
  "ncaClassificationRule" IS NULL OR "ncaClassificationRule" IN ('NATURAL_PERSON_NCA', 'TRUST_FEW_NATURAL_TRUSTEES', 'TRUST_UNEVIDENCED',
    'FINANCIALS_UNPROVEN', 'JURISTIC_OVER_THRESHOLD', 'LARGE_AGREEMENT', 'JURISTIC_SMALL_AGREEMENT')
  OR "ncaClassificationRule" = 'LEASE_NOT_CREDIT_AGREEMENT'
);
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_lease_rule_non_nca" CHECK (
  "ncaClassificationRule" IS DISTINCT FROM 'LEASE_NOT_CREDIT_AGREEMENT' OR "ncaRegime" IS NOT DISTINCT FROM 'NON_NCA'
);
ALTER TABLE "LoanApplication" DROP CONSTRAINT "LoanApplication_non_nca_requires_entity";
ALTER TABLE "LoanApplication" ADD CONSTRAINT "LoanApplication_non_nca_requires_entity" CHECK (
  "ncaRegime" IS DISTINCT FROM 'NON_NCA' OR "entityId" IS NOT NULL OR "ncaClassificationRule" IS NOT DISTINCT FROM 'LEASE_NOT_CREDIT_AGREEMENT'
);
ALTER TABLE "Loan" DROP CONSTRAINT "Loan_non_nca_requires_entity";
ALTER TABLE "Loan" ADD CONSTRAINT "Loan_non_nca_requires_entity" CHECK (
  "ncaRegime" = 'NCA' OR "entityId" IS NOT NULL OR "contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')
);

-- The insert rule of guardLoanApplicationNcaRegime ("insert unclassified or
-- NCA, then override") now admits the one NON_NCA insert a lease makes.
DO $body$
DECLARE definition TEXT; changed TEXT;
BEGIN
  SELECT pg_get_functiondef('public."guardLoanApplicationNcaRegime"()'::regprocedure) INTO definition;
  changed := replace(definition,
    'IF TG_OP = ''INSERT'' THEN' || chr(10) || '    IF NEW."ncaRegime" = ''NON_NCA'' THEN',
    'IF TG_OP = ''INSERT'' THEN' || chr(10) || '    IF NEW."ncaRegime" = ''NON_NCA'' AND NEW."ncaClassificationRule" IS DISTINCT FROM ''LEASE_NOT_CREDIT_AGREEMENT'' THEN');
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'guardLoanApplicationNcaRegime source shape changed'; END IF;
  EXECUTE changed;
END;
$body$;

CREATE OR REPLACE FUNCTION public."guardLeaseRuleFixed"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF (NEW."ncaClassificationRule" IS NOT DISTINCT FROM 'LEASE_NOT_CREDIT_AGREEMENT')
    IS DISTINCT FROM (OLD."ncaClassificationRule" IS NOT DISTINCT FROM 'LEASE_NOT_CREDIT_AGREEMENT') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lease application is written NON_NCA / LEASE_NOT_CREDIT_AGREEMENT and keeps that rule; no other application takes it';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LoanApplication_lease_rule_fixed" BEFORE UPDATE OF "ncaClassificationRule" ON "LoanApplication"
  FOR EACH ROW EXECUTE FUNCTION public."guardLeaseRuleFixed"();

-- At commit: an application carries the lease rule exactly when its asset
-- deal is a lease.
CREATE OR REPLACE FUNCTION public."checkLeaseApplicationBinding"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  target_application TEXT := CASE WHEN TG_TABLE_NAME = 'LoanApplication' THEN to_jsonb(NEW) ->> 'id' ELSE to_jsonb(NEW) ->> 'applicationId' END;
  rule TEXT;
  deal_is_lease BOOLEAN;
BEGIN
  SELECT a."ncaClassificationRule" INTO rule FROM "LoanApplication" a WHERE a."id" = target_application;
  SELECT d."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') INTO deal_is_lease
    FROM "AssetFinanceDeal" d WHERE d."applicationId" = target_application;
  IF (rule IS NOT DISTINCT FROM 'LEASE_NOT_CREDIT_AGREEMENT') IS DISTINCT FROM COALESCE(deal_is_lease, FALSE) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lease deal''s application is NON_NCA / LEASE_NOT_CREDIT_AGREEMENT, and only a lease deal''s is';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "LoanApplication_lease_binding" AFTER INSERT OR UPDATE OF "ncaClassificationRule" ON "LoanApplication"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkLeaseApplicationBinding"();
CREATE CONSTRAINT TRIGGER "AssetFinanceDeal_lease_binding" AFTER INSERT OR UPDATE OF "contractType", "applicationId" ON "AssetFinanceDeal"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkLeaseApplicationBinding"();

-- A lease loan is booked from a lease application, and only a lease loan is.
CREATE OR REPLACE FUNCTION public."guardLeaseLoanBinding"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE rule TEXT;
BEGIN
  SELECT a."ncaClassificationRule" INTO rule FROM "LoanApplication" a
    WHERE a."id" = NEW."applicationId" AND a."tenantId" = NEW."tenantId";
  IF (NEW."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) IS DISTINCT FROM (rule IS NOT DISTINCT FROM 'LEASE_NOT_CREDIT_AGREEMENT') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lease loan is booked from a NON_NCA / LEASE_NOT_CREDIT_AGREEMENT application, and only a lease loan is';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "Loan_lease_binding" BEFORE INSERT ON "Loan"
  FOR EACH ROW EXECUTE FUNCTION public."guardLeaseLoanBinding"();

-- The NON_NCA commit rule of assertDisbursedCreditLifeCoverage required an
-- entity borrower; a lease may be a sole proprietor's. The lease keeps every
-- other part of the rule, and its borrower must still be its application's.
DO $body$
DECLARE definition TEXT; changed TEXT; needle TEXT;
BEGIN
  SELECT pg_get_functiondef(('public."assertDisbursedCreditLife' || 'Coverage"(text)')::regprocedure) INTO definition;
  needle := '    OR loan_client_id IS NOT NULL' || chr(10)
    || '    OR application_client_id IS NOT NULL' || chr(10)
    || '    OR loan_entity_id IS NULL' || chr(10);
  changed := replace(definition, needle,
    '    OR (application_rule IS DISTINCT FROM ''LEASE_NOT_CREDIT_AGREEMENT'' AND (' || chr(10)
    || '      loan_client_id IS NOT NULL OR application_client_id IS NOT NULL OR loan_entity_id IS NULL))' || chr(10)
    || '    OR loan_client_id IS DISTINCT FROM application_client_id' || chr(10));
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'assertDisbursedCreditLife' || 'Coverage source shape changed'; END IF;
  EXECUTE changed;
END;
$body$;

-- A sole proprietor's lease application gets the entity application's status
-- rules (a decided application is final; DISBURSED never changes).
DO $body$
DECLARE definition TEXT; changed TEXT;
BEGIN
  SELECT pg_get_functiondef('public."guardEntityApplicationStatus"()'::regprocedure) INTO definition;
  changed := replace(definition,
    'IF (OLD."entityId" IS NULL AND NEW."entityId" IS NULL)',
    'IF (OLD."entityId" IS NULL AND NEW."entityId" IS NULL AND OLD."ncaClassificationRule" IS DISTINCT FROM ''LEASE_NOT_CREDIT_AGREEMENT'')');
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'guardEntityApplicationStatus source shape changed'; END IF;
  EXECUTE changed;
END;
$body$;

-- A lease loan is never deleted, whoever the lessee (an entity loan already is not).
CREATE OR REPLACE FUNCTION public."refuseLeaseLoanDelete"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM public."Loan" l WHERE l."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease loan is never deleted (TRUNCATE refused)';
    END IF;
    RETURN NULL;
  END IF;
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease loan is never deleted';
END;
$function$;
CREATE TRIGGER "Loan_refuse_lease_delete" BEFORE DELETE ON "Loan"
  FOR EACH ROW WHEN (OLD."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) EXECUTE FUNCTION public."refuseLeaseLoanDelete"();
CREATE TRIGGER "Loan_refuse_lease_truncate" BEFORE TRUNCATE ON "Loan"
  FOR EACH STATEMENT EXECUTE FUNCTION public."refuseLeaseLoanDelete"();

-- The lessor owns a leased vehicle: its eNaTIS owner, not only its
-- titleholder, must be the lender before payout.
DO $body$
DECLARE definition TEXT; changed TEXT; needle TEXT;
BEGIN
  SELECT pg_get_functiondef('public."guardPayoutChecklistItem"()'::regprocedure) INTO definition;
  needle := 'MESSAGE = ''The eNaTIS titleholder must be the lender''''s legal name'';' || chr(10) || '  END IF;';
  changed := replace(definition, needle, needle || chr(10)
    || '  IF NEW."item" = ''NATIS_TITLEHOLDER'' AND EXISTS (' || chr(10)
    || '    SELECT 1 FROM "AssetFinanceDeal" d JOIN "FinancedAsset" a ON a."id" = d."assetId" AND a."tenantId" = d."tenantId"' || chr(10)
    || '    WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId"' || chr(10)
    || '      AND d."contractType" IN (''OPERATING_LEASE'', ''FULL_MAINTENANCE_LEASE'')' || chr(10)
    || '      AND (a."natisOwner" IS NULL OR "payoutNormalisedName"(a."natisOwner") IS DISTINCT FROM (' || chr(10)
    || '        SELECT "payoutNormalisedName"(c."legalName") FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"))' || chr(10)
    || '  ) THEN' || chr(10)
    || '    RAISE EXCEPTION USING ERRCODE = ''23514'', MESSAGE = ''A leased asset''''s eNaTIS owner must be the lender''''s legal name'';' || chr(10)
    || '  END IF;');
  IF changed = definition THEN RAISE EXCEPTION USING MESSAGE = 'guardPayoutChecklistItem source shape changed'; END IF;
  EXECUTE changed;
END;
$body$;

-- ---------------------------------------------------------------------------
-- LeaseRental: one row per rental of a booked lease (lib/asset-finance/lease-booking.ts).
-- ---------------------------------------------------------------------------
ALTER TABLE "LeaseRental" ADD CONSTRAINT "LeaseRental_amounts" CHECK (
  "periodNo" >= 1
  AND "rentalExclVatCents" > 0
  AND "maintenanceExclVatCents" >= 0
  AND "vatCents" >= 0
  AND "totalCents" = "rentalExclVatCents" + "maintenanceExclVatCents" + "vatCents"
  AND "vatRate" >= 0 AND "vatRate" < 1
);

-- Written once per rental of a lease loan (an operating lease has no
-- maintenance), never deleted. The period, its loan, schedule row and due date
-- never change. The amounts change only before the rental is invoiced and
-- only inside a repricing: the transaction-local flag credaflow.lease_reprice
-- (lib/asset-finance/lease-reprice.ts) AND a ContractRate of the loan written
-- in this same transaction; the VAT rate stays the booked one and the VAT is
-- recomputed on it (vatHalfUpCents per line). The tax invoice is set once, to
-- an invoice of the same loan for the rental's total, supplied no later than
-- the due date, and before it only if money has reached the rental.
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
    IF NEW."taxInvoiceId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental is written uninvoiced';
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
  IF NEW."rentalExclVatCents" IS DISTINCT FROM OLD."rentalExclVatCents"
    OR NEW."maintenanceExclVatCents" IS DISTINCT FROM OLD."maintenanceExclVatCents"
    OR NEW."vatCents" IS DISTINCT FROM OLD."vatCents"
    OR NEW."totalCents" IS DISTINCT FROM OLD."totalCents"
    OR NEW."vatRate" IS DISTINCT FROM OLD."vatRate" THEN
    IF OLD."taxInvoiceId" IS NOT NULL OR NEW."taxInvoiceId" IS NOT NULL
      OR current_setting('credaflow.lease_reprice', true) IS DISTINCT FROM 'on'
      OR NOT EXISTS (SELECT 1 FROM "ContractRate" c WHERE c."loanId" = NEW."loanId" AND c."tenantId" = NEW."tenantId" AND c."createdAt" >= date_trunc('milliseconds', now()) - INTERVAL '1 millisecond') THEN
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
  IF OLD."taxInvoiceId" IS NULL AND NEW."taxInvoiceId" IS NOT NULL THEN
    SELECT i."loanId", i."totalInclVatCents", i."supplyDate" INTO invoice_row FROM "TaxInvoice" i
      WHERE i."id" = NEW."taxInvoiceId" AND i."tenantId" = NEW."tenantId";
    IF invoice_row."loanId" IS DISTINCT FROM NEW."loanId" OR invoice_row."totalInclVatCents" IS DISTINCT FROM NEW."totalCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease rental''s tax invoice is of its loan, for the rental''s total';
    END IF;
    -- Time of supply: the earlier of the due date and a payment towards the rental.
    IF invoice_row."supplyDate" > NEW."dueDate" OR (invoice_row."supplyDate" < NEW."dueDate" AND NOT EXISTS (
        SELECT 1 FROM "RepaymentSchedule" s WHERE s."id" = NEW."scheduleId" AND s."tenantId" = NEW."tenantId" AND s."totalPaid" > 0)) THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A lease rental is supplied on its due date, or earlier only once a payment has reached it';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "LeaseRental_guard" BEFORE INSERT OR UPDATE OR DELETE ON "LeaseRental"
  FOR EACH ROW EXECUTE FUNCTION public."guardLeaseRental"();
CREATE TRIGGER "LeaseRental_no_truncate" BEFORE TRUNCATE ON "LeaseRental"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardLeaseRental"();

-- At commit, a rental and its schedule row agree: same loan, the period is
-- the instalment number, and the schedule row's total due is the rental's
-- total (receipts, arrears and statements read the schedule). Checked when
-- either side is written.
CREATE OR REPLACE FUNCTION public."checkLeaseRentalSchedule"()
RETURNS trigger LANGUAGE plpgsql AS $function$
DECLARE
  bad BOOLEAN;
BEGIN
  IF TG_TABLE_NAME = 'LeaseRental' THEN
    SELECT s."loanId" IS DISTINCT FROM r."loanId" OR s."installmentNo" IS DISTINCT FROM r."periodNo" OR s."totalDue" IS DISTINCT FROM r."totalCents"
      OR (s."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date IS DISTINCT FROM r."dueDate"
      INTO bad
      FROM "LeaseRental" r JOIN "RepaymentSchedule" s ON s."id" = r."scheduleId" AND s."tenantId" = r."tenantId"
      WHERE r."id" = NEW."id";
  ELSE
    SELECT s."loanId" IS DISTINCT FROM r."loanId" OR s."installmentNo" IS DISTINCT FROM r."periodNo" OR s."totalDue" IS DISTINCT FROM r."totalCents"
      OR (s."dueDate" AT TIME ZONE 'UTC' AT TIME ZONE 'Africa/Johannesburg')::date IS DISTINCT FROM r."dueDate"
      INTO bad
      FROM "LeaseRental" r JOIN "RepaymentSchedule" s ON s."id" = r."scheduleId" AND s."tenantId" = r."tenantId"
      WHERE s."id" = NEW."id";
  END IF;
  IF bad THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A lease rental and its schedule row must agree: same loan, period = instalment number, total = total due, same due date';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "LeaseRental_matches_schedule" AFTER INSERT OR UPDATE ON "LeaseRental"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkLeaseRentalSchedule"();
CREATE CONSTRAINT TRIGGER "RepaymentSchedule_matches_lease_rental" AFTER UPDATE OF "totalDue", "installmentNo", "loanId", "dueDate" ON "RepaymentSchedule"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkLeaseRentalSchedule"();

-- Booking a lease writes a rental for every schedule row, with the deal's CPA
-- scope on the loan, before the deal becomes BOOKED (lib/asset-finance/booking.ts).
CREATE OR REPLACE FUNCTION public."guardLeaseDealBooking"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."status" = 'BOOKED' AND OLD."status" IS DISTINCT FROM 'BOOKED'
    AND NEW."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') THEN
    IF NOT EXISTS (
      SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
        AND l."cpaApplies" IS NOT DISTINCT FROM NEW."cpaApplies" AND l."cpaRule" IS NOT DISTINCT FROM NEW."cpaRule"
        AND l."balloonAmount" IS NULL
    ) OR EXISTS (
      SELECT 1 FROM "RepaymentSchedule" s
      WHERE s."loanId" = NEW."loanId" AND s."tenantId" = NEW."tenantId"
        AND NOT EXISTS (SELECT 1 FROM "LeaseRental" r WHERE r."scheduleId" = s."id" AND r."tenantId" = s."tenantId")
    ) OR NOT EXISTS (SELECT 1 FROM "RepaymentSchedule" s WHERE s."loanId" = NEW."loanId" AND s."tenantId" = NEW."tenantId") THEN
      RAISE EXCEPTION USING ERRCODE = '23514',
        MESSAGE = 'A lease is booked with its deal''s CPA scope on the loan, no balloon, and a lease rental for every schedule row';
    END IF;
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "AssetFinanceDeal_lease_booking" BEFORE UPDATE OF "status" ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."guardLeaseDealBooking"();

-- The eNaTIS owner, like the titleholder, is fixed once the NATIS_TITLEHOLDER
-- checklist item that attests it is confirmed.
CREATE OR REPLACE FUNCTION public."guardFinancedAssetNatisOwner"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."natisOwner" IS DISTINCT FROM OLD."natisOwner" AND "assetChecklistConfirmed"(OLD."tenantId", OLD."id", 'NATIS_TITLEHOLDER') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset''s eNaTIS owner is attested on a payout checklist; it is fixed';
  END IF;
  RETURN NEW;
END;
$function$;
CREATE TRIGGER "FinancedAsset_natis_owner_frozen" BEFORE UPDATE OF "natisOwner" ON "FinancedAsset"
  FOR EACH ROW EXECUTE FUNCTION public."guardFinancedAssetNatisOwner"();

-- At commit, every schedule row of a lease loan is a rental (has its
-- LeaseRental): nothing else is billed on a lease outside the lease code.
CREATE OR REPLACE FUNCTION public."checkLeaseScheduleRow"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF EXISTS (SELECT 1 FROM "Loan" l WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
      AND l."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE'))
    AND NOT EXISTS (SELECT 1 FROM "LeaseRental" r WHERE r."scheduleId" = NEW."id" AND r."tenantId" = NEW."tenantId") THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease loan''s schedule row is one of its rentals';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "RepaymentSchedule_lease_row_is_rental" AFTER INSERT ON "RepaymentSchedule"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkLeaseScheduleRow"();

-- At commit, a lease loan is the one its BOOKED lease deal booked: same
-- contract type, same asset. A loan cannot be written onto a lease
-- application any other way (an unbooked or deleted deal, no asset).
CREATE OR REPLACE FUNCTION public."checkLeaseLoanBooked"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  IF NEW."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE') AND NOT EXISTS (
    SELECT 1 FROM "AssetFinanceDeal" d WHERE d."loanId" = NEW."id" AND d."tenantId" = NEW."tenantId" AND d."status" = 'BOOKED'
      AND d."contractType" = NEW."contractType" AND d."applicationId" = NEW."applicationId" AND NEW."assetId" IS NOT NULL AND d."assetId" = NEW."assetId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease loan is booked by its lease deal: BOOKED, same contract type, application and asset';
  END IF;
  RETURN NULL;
END;
$function$;
CREATE CONSTRAINT TRIGGER "Loan_lease_booked_by_deal" AFTER INSERT OR UPDATE OF "assetId", "applicationId" ON "Loan"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public."checkLeaseLoanBooked"();

-- A lease deal is never deleted (it is cancelled): its application's lease
-- rule rests on it (checkLeaseApplicationBinding).
CREATE OR REPLACE FUNCTION public."refuseLeaseDealDelete"()
RETURNS trigger LANGUAGE plpgsql AS $function$
BEGIN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A lease deal is never deleted; cancel it';
END;
$function$;
CREATE TRIGGER "AssetFinanceDeal_refuse_lease_delete" BEFORE DELETE ON "AssetFinanceDeal"
  FOR EACH ROW WHEN (OLD."contractType" IN ('OPERATING_LEASE', 'FULL_MAINTENANCE_LEASE')) EXECUTE FUNCTION public."refuseLeaseDealDelete"();
