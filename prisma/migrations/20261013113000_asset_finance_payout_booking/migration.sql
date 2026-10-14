-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "dualApprovalRequired" BOOLEAN NOT NULL DEFAULT false;

-- AddForeignKey
ALTER TABLE "PayoutChecklistItem" ADD CONSTRAINT "PayoutChecklistItem_tenantId_confirmedById_fkey" FOREIGN KEY ("tenantId", "confirmedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "PayoutChecklistItem" ADD CONSTRAINT "PayoutChecklistItem_tenantId_evidenceDocumentId_fkey" FOREIGN KEY ("tenantId", "evidenceDocumentId") REFERENCES "EntityDocument"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_tenantId_createdById_fkey" FOREIGN KEY ("tenantId", "createdById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_tenantId_approvedById_fkey" FOREIGN KEY ("tenantId", "approvedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_tenantId_releasedById_fkey" FOREIGN KEY ("tenantId", "releasedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Hand-written (payout gate and booking, goal §4.10, DESIGN D8)
-- ---------------------------------------------------------------------------

-- A checklist item is confirmed whole: who and when together; evidence only
-- on a confirmed item; every item but the three signing items names its
-- evidence document (the signing items' evidence is the deal's DealSigner
-- rows, which guardAssetDealContract already required for CONTRACTED).
ALTER TABLE "PayoutChecklistItem" ADD CONSTRAINT "PayoutChecklistItem_confirmation_complete" CHECK (
  ("confirmedById" IS NULL) = ("confirmedAt" IS NULL)
  AND ("evidenceDocumentId" IS NULL OR "confirmedById" IS NOT NULL)
);
ALTER TABLE "PayoutChecklistItem" ADD CONSTRAINT "PayoutChecklistItem_evidence_required" CHECK (
  "confirmedById" IS NULL
  OR "item" IN ('SIGNED_AGREEMENT', 'SIGNED_SURETYSHIPS', 'SIGNED_RESOLUTION')
  OR "evidenceDocumentId" IS NOT NULL
);

-- The items a deal's payout needs: every kind, except NATIS_TITLEHOLDER when
-- the asset carries no registration number. A kind added to the enum later is
-- required until someone decides otherwise (fails closed). Mirrors
-- requiredChecklistKinds in lib/asset-finance/payout-checklist.ts.
CREATE OR REPLACE FUNCTION public."payoutChecklistRequiredKinds"(tenant_id TEXT, deal_id TEXT)
RETURNS SETOF "PayoutChecklistItemKind"
LANGUAGE sql
STABLE
AS $function$
  SELECT kind
  FROM "AssetFinanceDeal" d
  JOIN "FinancedAsset" a ON a."id" = d."assetId" AND a."tenantId" = d."tenantId"
  CROSS JOIN LATERAL unnest(enum_range(NULL::"PayoutChecklistItemKind")) AS kind
  WHERE d."id" = deal_id AND d."tenantId" = tenant_id
    AND (kind <> 'NATIS_TITLEHOLDER' OR NULLIF(btrim(a."registrationNumber"), '') IS NOT NULL)
$function$;

-- Upper case, outer spaces trimmed, inner runs of whitespace one space.
-- Mirrors normaliseName in lib/asset-finance/payout-checklist.ts.
CREATE OR REPLACE FUNCTION public."payoutNormalisedName"(value TEXT)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT upper(regexp_replace(btrim(value), '\s+', ' ', 'g'))
$function$;

-- Checklist rows are created unconfirmed on a CONTRACTED deal, with
-- `required` as payoutChecklistRequiredKinds says. The only change ever made
-- to a row is its confirmation, while the deal is still CONTRACTED; a
-- confirmed row is immutable, and no row is deleted. A confirmation's
-- evidence is a live, staff-uploaded document of this deal of the kind the
-- item calls for, and the asset or supplier facts the item attests hold now.
CREATE OR REPLACE FUNCTION public."guardPayoutChecklistItem"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deal_status TEXT;
  evidence_types TEXT[];
  asset_row RECORD;
BEGIN
  IF TG_OP = 'TRUNCATE' OR TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A payout checklist item is never deleted';
  END IF;

  IF TG_OP = 'UPDATE' THEN
    IF OLD."confirmedAt" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A confirmed payout checklist item is immutable';
    END IF;
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."tenantId" IS DISTINCT FROM OLD."tenantId"
      OR NEW."dealId" IS DISTINCT FROM OLD."dealId"
      OR NEW."item" IS DISTINCT FROM OLD."item"
      OR NEW."required" IS DISTINCT FROM OLD."required"
      OR NEW."confirmedAt" IS NULL
    THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A payout checklist item changes only by being confirmed';
    END IF;
  END IF;

  SELECT d."status"::TEXT INTO deal_status
  FROM "AssetFinanceDeal" d WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId";
  IF deal_status IS DISTINCT FROM 'CONTRACTED' THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'Payout checklist items are created and confirmed only while the deal is CONTRACTED';
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."confirmedAt" IS NOT NULL OR NEW."confirmedById" IS NOT NULL THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = 'A payout checklist item is created unconfirmed';
    END IF;
    IF NEW."required" IS DISTINCT FROM (NEW."item" IN (SELECT * FROM "payoutChecklistRequiredKinds"(NEW."tenantId", NEW."dealId"))) THEN
      RAISE EXCEPTION USING
        ERRCODE = '23514',
        MESSAGE = format('Payout checklist item %s: required must be what the requirement table says', NEW."item");
    END IF;
    RETURN NEW;
  END IF;

  evidence_types := CASE NEW."item"::TEXT
    WHEN 'SUPPLIER_INVOICE_MATCHES_ASSET' THEN ARRAY['SUPPLIER_INVOICE']
    WHEN 'SUPPLIER_BANK_VERIFIED' THEN ARRAY['BANK_STATEMENT', 'OTHER']
    WHEN 'INSURANCE_NOTES_LENDER' THEN ARRAY['INSURANCE_NOTING']
    WHEN 'TRACKER_CONFIRMED' THEN ARRAY['TRACKER_CERTIFICATE']
    WHEN 'DELIVERY_AND_ACCEPTANCE' THEN ARRAY['DELIVERY_ACCEPTANCE']
    WHEN 'NATIS_TITLEHOLDER' THEN ARRAY['NATIS_DOCUMENT']
    ELSE ARRAY[]::TEXT[]
  END;
  IF NEW."evidenceDocumentId" IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM "EntityDocument" doc
    WHERE doc."id" = NEW."evidenceDocumentId" AND doc."tenantId" = NEW."tenantId"
      AND doc."dealId" = NEW."dealId" AND doc."deletedAt" IS NULL
      AND doc."uploadedByType" = 'staff'
      AND doc."docType"::TEXT = ANY (evidence_types)
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = format('Payout checklist item %s: the evidence must be a live staff upload on this deal of type %s',
        NEW."item", array_to_string(evidence_types, ' or '));
  END IF;

  SELECT a."registrationNumber", a."natisTitleholder", a."trackerId", a."lenderNotedConfirmed", d."supplierId"
  INTO asset_row
  FROM "AssetFinanceDeal" d
  JOIN "FinancedAsset" a ON a."id" = d."assetId" AND a."tenantId" = d."tenantId"
  WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId";

  IF NEW."item" = 'INSURANCE_NOTES_LENDER' AND asset_row."lenderNotedConfirmed" IS NOT TRUE THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset''s insurance does not record the lender''s interest as noted';
  END IF;
  IF NEW."item" = 'TRACKER_CONFIRMED' AND NULLIF(btrim(asset_row."trackerId"), '') IS NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The asset has no tracker id';
  END IF;
  IF NEW."item" = 'SUPPLIER_BANK_VERIFIED' AND NOT EXISTS (
    SELECT 1 FROM "SupplierBankAccount" acc
    WHERE acc."tenantId" = NEW."tenantId" AND acc."supplierId" = asset_row."supplierId" AND acc."status" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The supplier has no APPROVED bank account';
  END IF;
  IF NEW."item" = 'NATIS_TITLEHOLDER' AND (
    NULLIF(btrim(asset_row."registrationNumber"), '') IS NULL
    OR "payoutNormalisedName"(asset_row."natisTitleholder") IS DISTINCT FROM (
      SELECT "payoutNormalisedName"(c."legalName") FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId"
    )
    OR asset_row."natisTitleholder" IS NULL
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The eNaTIS titleholder must be the lender''s legal name';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "PayoutChecklistItem_guard" BEFORE INSERT OR UPDATE OR DELETE ON "PayoutChecklistItem"
  FOR EACH ROW EXECUTE FUNCTION public."guardPayoutChecklistItem"();
CREATE TRIGGER "PayoutChecklistItem_no_truncate" BEFORE TRUNCATE ON "PayoutChecklistItem"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardPayoutChecklistItem"();

-- Payout evidence is kept: a document a confirmed checklist item points at
-- cannot be soft-deleted.
CREATE OR REPLACE FUNCTION public."guardPayoutEvidenceDocument"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."deletedAt" IS NULL AND NEW."deletedAt" IS NOT NULL
    AND EXISTS (
      SELECT 1 FROM "PayoutChecklistItem" i
      WHERE i."evidenceDocumentId" = OLD."id" AND i."tenantId" = OLD."tenantId"
    )
  THEN
    RAISE EXCEPTION USING
      ERRCODE = '23514',
      MESSAGE = 'A document that evidences a payout checklist item cannot be deleted';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "EntityDocument_payout_evidence" BEFORE UPDATE OF "deletedAt" ON "EntityDocument"
  FOR EACH ROW EXECUTE FUNCTION public."guardPayoutEvidenceDocument"();

-- A payout's state is written whole. Four eyes: at or above the threshold the
-- approver is a different user (both are real users of the tenant, composite
-- FKs, so the ids compare exactly); below it the creator's creation is the
-- approval and records the creator as approver.
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_amount_positive" CHECK ("amountCents" > 0);
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_status_shape" CHECK (
  ("status" = 'PENDING_APPROVAL' AND "approvedById" IS NULL AND "approvedAt" IS NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL)
  OR ("status" = 'APPROVED' AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "releasedById" IS NULL AND "releasedAt" IS NULL)
  OR ("status" = 'RELEASED' AND "approvedById" IS NOT NULL AND "approvedAt" IS NOT NULL AND "releasedById" IS NOT NULL AND "releasedAt" IS NOT NULL)
);
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_four_eyes" CHECK (
  "approvedById" IS NULL
  OR ("dualApprovalRequired" AND "approvedById" <> "createdById")
  OR (NOT "dualApprovalRequired" AND "approvedById" = "createdById")
);

-- A payout is inserted only for a CONTRACTED deal whose every required
-- checklist item is confirmed, to the deal supplier's APPROVED bank account
-- of the same tenant, for exactly the cash price incl. VAT less the deposit
-- and the trade-in. The trigger sets dualApprovalRequired from the tenant's
-- assetPayoutDualApprovalCents (no config row: required, fails closed); a
-- dual payout is inserted PENDING_APPROVAL, a single one APPROVED by its
-- creator. The deal, asset and account rows are share-locked to commit, so
-- none of them changes underneath. Afterwards only PENDING_APPROVAL →
-- APPROVED (deal still CONTRACTED) and APPROVED → RELEASED (deal BOOKED,
-- account still APPROVED) are allowed; nothing else ever changes, a RELEASED
-- payout never changes, and no payout is deleted.
CREATE OR REPLACE FUNCTION public."guardPayout"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  deal_row RECORD;
  threshold INTEGER;
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
    SELECT c."assetPayoutDualApprovalCents" INTO threshold FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId";
    NEW."dualApprovalRequired" := threshold IS NULL OR NEW."amountCents" >= threshold;
    IF NEW."status" = 'RELEASED' OR NEW."status" <> (CASE WHEN NEW."dualApprovalRequired" THEN 'PENDING_APPROVAL' ELSE 'APPROVED' END)::"PayoutStatus" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = format(
        'A payout of %s cents is created %s (dual approval from %s cents)',
        NEW."amountCents", CASE WHEN NEW."dualApprovalRequired" THEN 'PENDING_APPROVAL' ELSE 'APPROVED by its creator' END, threshold);
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."status" = 'RELEASED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A released payout is immutable';
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

CREATE TRIGGER "Payout_guard" BEFORE INSERT OR UPDATE OR DELETE ON "Payout"
  FOR EACH ROW EXECUTE FUNCTION public."guardPayout"();
CREATE TRIGGER "Payout_no_truncate" BEFORE TRUNCATE ON "Payout"
  FOR EACH STATEMENT EXECUTE FUNCTION public."guardPayout"();

-- A deal is BOOKED only from CONTRACTED, naming the loan booked for it: that
-- loan is on the deal's own application, entity and asset, NON_NCA, of the
-- deal's contract type; and the deal's payout is APPROVED. A deal's loanId is
-- set only by that move, and a BOOKED deal's status and loan never change.
CREATE OR REPLACE FUNCTION public."guardAssetDealBooking"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."status" = 'BOOKED' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."loanId" IS DISTINCT FROM OLD."loanId" THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A booked deal keeps its status and its loan';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."status" <> 'BOOKED' THEN
    IF NEW."loanId" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal names its loan only when it is booked';
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' OR OLD."status" <> 'CONTRACTED' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset deal is booked only from CONTRACTED';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Loan" l
    WHERE l."id" = NEW."loanId" AND l."tenantId" = NEW."tenantId"
      AND l."applicationId" = NEW."applicationId" AND l."entityId" = NEW."entityId"
      AND l."assetId" = NEW."assetId" AND l."ncaRegime" = 'NON_NCA' AND l."contractType" = NEW."contractType"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A booked deal names a NON_NCA loan on its own application, entity and asset';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "Payout" p WHERE p."dealId" = NEW."id" AND p."tenantId" = NEW."tenantId" AND p."status" = 'APPROVED'
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal is booked only with its payout APPROVED';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_booking_gate" BEFORE INSERT OR UPDATE OF "status", "loanId" ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetDealBooking"();
