-- Segregation of duties (Fair Score audit 2026-10-16, decision §2a.3).
--
-- TenantConfig.requireSegregationOfDuties, on by default (existing rows too).
-- While on:
--   * the staff member who approved a consumer application cannot disburse it
--     (LoanApplication.disbursedById, written with the DISBURSED transition);
--   * the staff witness of an in-branch consumer signature cannot countersign
--     the agreement for the provider;
--   * every asset-finance payout needs a second approver, whatever its amount
--     (guardPayout sets dualApprovalRequired; CHECK Payout_four_eyes then
--     refuses the creator as approver).
-- A tenant with no config row is treated as on. Changed only by ADMIN or
-- SUPER_ADMIN, audited (lib/security/segregation-of-duties.ts).

-- AlterTable
ALTER TABLE "LoanApplication" ADD COLUMN "disbursedById" TEXT;

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN "requireSegregationOfDuties" BOOLEAN NOT NULL DEFAULT true;

-- ---------------------------------------------------------------------------
-- Hand-written
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public."tenantRequiresSegregationOfDuties"(tenant_id TEXT)
 RETURNS BOOLEAN
 LANGUAGE sql
 STABLE
AS $function$
  SELECT COALESCE(
    (SELECT c."requireSegregationOfDuties" FROM "TenantConfig" c WHERE c."tenantId" = tenant_id),
    TRUE
  );
$function$;

-- Consumer applications only: an asset-finance deal's application (an entity
-- or a natural-person deal) is booked by lib/asset-finance/booking.ts and its
-- maker-checker pair is its payout, below. disbursedById is written only with
-- the DISBURSED transition and never changes afterwards.
CREATE OR REPLACE FUNCTION public."guardLoanApplicationSegregationOfDuties"()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  disbursing BOOLEAN;
  countersigning BOOLEAN;
BEGIN
  disbursing := NEW."status" = 'DISBURSED'::"AppStatus"
    AND OLD."status" IS DISTINCT FROM 'DISBURSED'::"AppStatus";
  countersigning := OLD."agreementCountersignedAt" IS NULL
    AND NEW."agreementCountersignedAt" IS NOT NULL;

  IF NEW."disbursedById" IS DISTINCT FROM OLD."disbursedById" AND NOT disbursing THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'The staff member who disbursed an application is recorded only with the DISBURSED transition';
  END IF;

  IF NEW."entityId" IS NOT NULL OR EXISTS (
    SELECT 1 FROM "AssetFinanceDeal" d WHERE d."applicationId" = NEW."id" AND d."tenantId" = NEW."tenantId"
  ) THEN
    RETURN NEW;
  END IF;

  IF disbursing AND "tenantRequiresSegregationOfDuties"(NEW."tenantId") THEN
    IF NEW."disbursedById" IS NULL OR LENGTH(BTRIM(NEW."disbursedById")) = 0 THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Segregation of duties: a disbursement must record the staff member who made it';
    END IF;
    IF NEW."disbursedById" = NEW."approvedById" THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'Segregation of duties: the staff member who approved an application cannot disburse it';
    END IF;
  END IF;

  IF countersigning
    AND NEW."agreementSignedMethod" = 'branch'
    AND NEW."agreementSignedByUserId" = NEW."agreementCountersignedById"
    AND "tenantRequiresSegregationOfDuties"(NEW."tenantId")
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Segregation of duties: the staff witness of the in-branch signature cannot countersign for the provider';
  END IF;

  RETURN NEW;
END;
$function$;

-- "z_": BEFORE triggers fire in name order, so every evidence guard has
-- refused (or passed) a write before this asks who made it.
CREATE TRIGGER "LoanApplication_z_guard_segregation_of_duties" BEFORE UPDATE ON "LoanApplication" FOR EACH ROW WHEN (((new.status IS DISTINCT FROM old.status) OR (new."agreementCountersignedAt" IS DISTINCT FROM old."agreementCountersignedAt") OR (new."disbursedById" IS DISTINCT FROM old."disbursedById"))) EXECUTE FUNCTION "guardLoanApplicationSegregationOfDuties"();

-- guardPayout (20261013114300) with segregation of duties: while it is on,
-- every payout is dual-approval. Otherwise verbatim.
CREATE OR REPLACE FUNCTION public."guardPayout"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deal_row RECORD;
  threshold INTEGER;
  segregated BOOLEAN;
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is never deleted';
  END IF;

  SELECT d."status"::TEXT AS status, d."supplierId", d."depositCents", d."tradeInCents",
         a."cashPriceExclVatCents", a."vatCents"
  INTO deal_row
  FROM "AssetFinanceDeal" d
  JOIN "FinancedAsset" a ON a."id" = d."assetId" AND a."tenantId" = d."tenantId"
  WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId"
  FOR SHARE OF d, a;

  IF TG_OP = 'INSERT' THEN
    IF deal_row.status IS DISTINCT FROM 'CONTRACTED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is created only for a CONTRACTED deal';
    END IF;
    IF EXISTS (
      SELECT 1 FROM "payoutChecklistRequiredKinds"(NEW."tenantId", NEW."dealId") AS kind
      WHERE NOT EXISTS (
        SELECT 1 FROM "PayoutChecklistItem" i
        WHERE i."dealId" = NEW."dealId" AND i."tenantId" = NEW."tenantId" AND i."item" = kind AND i."confirmedAt" IS NOT NULL
      )
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout needs every required checklist item confirmed';
    END IF;
    PERFORM 1 FROM "SupplierBankAccount" acc
    WHERE acc."id" = NEW."supplierBankAccountId" AND acc."tenantId" = NEW."tenantId"
      AND acc."supplierId" = deal_row."supplierId" AND acc."status" = 'APPROVED'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout goes only to the deal supplier''s APPROVED bank account';
    END IF;
    IF NEW."amountCents"::BIGINT <> deal_row."cashPriceExclVatCents"::BIGINT + deal_row."vatCents" - deal_row."depositCents" - deal_row."tradeInCents" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is the cash price incl. VAT less the deposit and the trade-in';
    END IF;
    SELECT c."assetPayoutDualApprovalCents", c."requireSegregationOfDuties" INTO threshold, segregated
    FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
    -- No config row: both fail closed (dual approval).
    NEW."dualApprovalRequired" := threshold IS NULL OR segregated IS NOT FALSE OR NEW."amountCents" >= threshold;
    IF NEW."status" NOT IN ('PENDING_APPROVAL', 'APPROVED')
      OR NEW."status" <> (CASE WHEN NEW."dualApprovalRequired" THEN 'PENDING_APPROVAL' ELSE 'APPROVED' END)::"PayoutStatus" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format(
        'A payout of %s cents is created %s (dual approval from %s cents%s)',
        NEW."amountCents", CASE WHEN NEW."dualApprovalRequired" THEN 'PENDING_APPROVAL' ELSE 'APPROVED by its creator' END, threshold,
        CASE WHEN segregated IS NOT FALSE THEN ', and always under segregation of duties' ELSE '' END);
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RELEASED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A released payout is immutable';
  END IF;
  IF OLD."status" = 'CANCELLED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A cancelled payout is immutable';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
    OR NEW."dealId" IS DISTINCT FROM OLD."dealId"
    OR NEW."supplierBankAccountId" IS DISTINCT FROM OLD."supplierBankAccountId"
    OR NEW."amountCents" IS DISTINCT FROM OLD."amountCents"
    OR NEW."dualApprovalRequired" IS DISTINCT FROM OLD."dualApprovalRequired"
    OR NEW."createdById" IS DISTINCT FROM OLD."createdById"
    OR NEW."createdAt" IS DISTINCT FROM OLD."createdAt"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout''s deal, account, amount and creator are fixed';
  END IF;

  IF OLD."status" = 'PENDING_APPROVAL' AND NEW."status" = 'APPROVED' THEN
    IF deal_row.status IS DISTINCT FROM 'CONTRACTED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is approved only while its deal is CONTRACTED';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" IN ('PENDING_APPROVAL', 'APPROVED') AND NEW."status" = 'CANCELLED'
    AND NEW."approvedById" IS NOT DISTINCT FROM OLD."approvedById"
    AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt"
  THEN
    IF deal_row.status IS DISTINCT FROM 'CONTRACTED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is cancelled only while its deal is CONTRACTED';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'APPROVED' AND NEW."status" = 'RELEASED'
    AND NEW."approvedById" IS NOT DISTINCT FROM OLD."approvedById"
    AND NEW."approvedAt" IS NOT DISTINCT FROM OLD."approvedAt"
  THEN
    IF deal_row.status IS DISTINCT FROM 'BOOKED' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is released only with its deal BOOKED';
    END IF;
    PERFORM 1 FROM "SupplierBankAccount" acc
    WHERE acc."id" = NEW."supplierBankAccountId" AND acc."tenantId" = NEW."tenantId" AND acc."status" = 'APPROVED'
    FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A payout is released only to a bank account that is still APPROVED';
    END IF;
    RETURN NEW;
  END IF;

  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format('A payout cannot move from %s to %s', OLD."status", NEW."status");
END;
$function$;
