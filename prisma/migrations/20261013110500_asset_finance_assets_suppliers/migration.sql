-- ---------------------------------------------------------------------------
-- Hand-written (asset register and supplier bank accounts, docs/asset-finance/DESIGN.md D8)
-- ---------------------------------------------------------------------------

-- Book-wide duplicate check: one serial number, and one VIN, per tenant across
-- every asset still financed. Case and surrounding whitespace do not make a
-- second asset. An asset's identifiers are freed only when its deal releases
-- it (releasedAt), so the same machine can be financed again after settlement.
CREATE UNIQUE INDEX "FinancedAsset_serial_unreleased_key" ON "FinancedAsset" ("tenantId", upper(btrim("serialNumber"))) WHERE "releasedAt" IS NULL;
CREATE UNIQUE INDEX "FinancedAsset_vin_unreleased_key" ON "FinancedAsset" ("tenantId", upper(btrim("vin"))) WHERE "releasedAt" IS NULL AND "vin" IS NOT NULL;

-- An identifier is never blank: a blank serial would match every other blank.
ALTER TABLE "FinancedAsset" ADD CONSTRAINT "FinancedAsset_identifiers_present" CHECK (length(btrim("serialNumber")) > 0 AND ("vin" IS NULL OR length(btrim("vin")) > 0));
ALTER TABLE "FinancedAsset" ADD CONSTRAINT "FinancedAsset_year_range" CHECK ("year" BETWEEN 1950 AND 2100);
ALTER TABLE "FinancedAsset" ADD CONSTRAINT "FinancedAsset_amounts_non_negative" CHECK ("cashPriceExclVatCents" >= 0 AND "vatCents" >= 0 AND ("residualCents" IS NULL OR "residualCents" >= 0));
ALTER TABLE "FinancedAsset" ADD CONSTRAINT "FinancedAsset_usage_non_negative" CHECK (("hours" IS NULL OR "hours" >= 0) AND ("odometerKm" IS NULL OR "odometerKm" >= 0));

ALTER TABLE "AssetValuation" ADD CONSTRAINT "AssetValuation_amount_positive" CHECK ("amountCents" > 0);

-- A supplier bank account is approved by someone other than its requester.
ALTER TABLE "SupplierBankAccount" ADD CONSTRAINT "SupplierBankAccount_four_eyes" CHECK ("decidedById" IS NULL OR lower(btrim("decidedById")) <> lower(btrim("requestedById")));
-- Decision fields are all-or-nothing with the status: a PENDING row carries no
-- decision and no AVS evidence; every decided row says who decided and when.
ALTER TABLE "SupplierBankAccount" ADD CONSTRAINT "SupplierBankAccount_decision_complete" CHECK (
  ("status" = 'PENDING' AND "decidedById" IS NULL AND "decidedAt" IS NULL AND "avsResult" IS NULL AND "avsPassed" IS NULL)
  OR ("status" <> 'PENDING' AND "decidedById" IS NOT NULL AND length(btrim("decidedById")) > 0 AND "decidedAt" IS NOT NULL)
);
-- An account that was approved records the verification behind the approval.
ALTER TABLE "SupplierBankAccount" ADD CONSTRAINT "SupplierBankAccount_approval_evidence" CHECK ("status" NOT IN ('APPROVED', 'SUPERSEDED') OR "avsResult" IS NOT NULL);

-- At most one payable account per supplier. Approving a new one supersedes the
-- current one first, in the same transaction.
CREATE UNIQUE INDEX "SupplierBankAccount_one_approved_per_supplier" ON "SupplierBankAccount" ("tenantId", "supplierId") WHERE "status" = 'APPROVED';

-- A request is born PENDING. The account details, its supplier and its
-- requester never change: a different account is a new request, so an
-- approver always approves exactly the details that were requested. PENDING
-- moves only to APPROVED or REJECTED. A decided row is frozen, except that an
-- APPROVED account may become SUPERSEDED.
CREATE OR REPLACE FUNCTION "guardSupplierBankAccount"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A supplier bank account is created PENDING and approved by a second user';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."supplierId" IS DISTINCT FROM OLD."supplierId"
    OR NEW."bankName" IS DISTINCT FROM OLD."bankName"
    OR NEW."branchCode" IS DISTINCT FROM OLD."branchCode"
    OR NEW."accountNumber" IS DISTINCT FROM OLD."accountNumber"
    OR NEW."accountHolder" IS DISTINCT FROM OLD."accountHolder"
    OR NEW."accountType" IS DISTINCT FROM OLD."accountType"
    OR NEW."requestedById" IS DISTINCT FROM OLD."requestedById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A supplier bank account''s details are fixed; request a new account instead';
  END IF;

  IF OLD."status" = 'PENDING' THEN
    IF NEW."status" = 'SUPERSEDED' THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A PENDING supplier bank account is approved or rejected, never superseded';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."decidedById" IS DISTINCT FROM OLD."decidedById"
    OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt"
    OR NEW."avsResult" IS DISTINCT FROM OLD."avsResult"
    OR NEW."avsPassed" IS DISTINCT FROM OLD."avsPassed"
    OR (NEW."status" IS DISTINCT FROM OLD."status"
        AND NOT (OLD."status" = 'APPROVED' AND NEW."status" = 'SUPERSEDED'))
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A decided supplier bank account is frozen; only APPROVED may become SUPERSEDED';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "SupplierBankAccount_guard_insert" BEFORE INSERT ON "SupplierBankAccount"
  FOR EACH ROW EXECUTE FUNCTION "guardSupplierBankAccount"();
CREATE TRIGGER "SupplierBankAccount_guard_update" BEFORE UPDATE ON "SupplierBankAccount"
  FOR EACH ROW EXECUTE FUNCTION "guardSupplierBankAccount"();
