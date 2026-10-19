-- Slice 5 part A, review round 1 (docs/asset-finance/SLICE5.md, deviations
-- 29-38). The Prisma part first (generated), then the hand-written rules; each
-- refuses with ERRCODE 23514 like the rest. Additive, except two replacements
-- the review asked for: the duplicate unique index on
-- DealerCommissionLine.reversesLineId (the composite (tenantId, reversesLineId)
-- one stays) and guardAssetDealDealer, whose snapshot base changes.

-- DropIndex
DROP INDEX "DealerCommissionLine_reversesLineId_key";

-- AlterTable
ALTER TABLE "Client" ADD COLUMN     "dealerContactVerifiedAt" TIMESTAMP(3),
ADD COLUMN     "dealerContactVerifiedById" TEXT;

-- AlterTable
ALTER TABLE "DealerPayableRun" ADD COLUMN     "dealerTaxInvoiceDate" DATE,
ADD COLUMN     "dealerTaxInvoiceReference" TEXT;

-- AddForeignKey
ALTER TABLE "Client" ADD CONSTRAINT "Client_tenantId_dealerContactVerifiedById_fkey" FOREIGN KEY ("tenantId", "dealerContactVerifiedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Commission base = the goods advance ---------------------------------------

-- Unchanged but for the base (was COALESCE(approvedAmount, appliedAmount),
-- which carries the financed fees). The deposit, trade-in and asset price are
-- frozen from APPROVED by the existing deal and asset guards.
CREATE OR REPLACE FUNCTION "guardAssetDealDealer"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  today DATE := (now() AT TIME ZONE 'Africa/Johannesburg')::date;
  rate RECORD;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."dealerId" IS NULL THEN
      RETURN NEW; -- a staff deal: the CHECKs keep its dealer columns empty
    END IF;
    IF NEW."dealerSubmittedAt" IS NOT NULL OR num_nonnulls(NEW."dealerCommissionSource", NEW."dealerCommissionRateId", NEW."dealerCommissionBps",
        NEW."dealerCommissionFlatCents", NEW."dealerCommissionBaseCents", NEW."dealerCommissionSnapshotAt") > 0 THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal is created unsubmitted and without a commission snapshot';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "Dealer" d WHERE d."id" = NEW."dealerId" AND d."tenantId" = NEW."tenantId" AND d."active") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal names an active dealer of the lender';
    END IF;
    IF NEW."dealerUserId" IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM "DealerUser" u
      WHERE u."id" = NEW."dealerUserId" AND u."tenantId" = NEW."tenantId" AND u."dealerId" = NEW."dealerId" AND u."active"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal is created by an active user of that dealer';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "TenantConfig" c WHERE c."tenantId" = NEW."tenantId" AND c."featureDealerPortal") THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'The dealer portal is off for this lender';
    END IF;
    IF NOT (
      (NEW."entityId" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "BusinessEntity" e WHERE e."id" = NEW."entityId" AND e."tenantId" = NEW."tenantId" AND e."createdByDealerId" = NEW."dealerId"))
      OR (NEW."clientId" IS NOT NULL AND EXISTS (
        SELECT 1 FROM "Client" c WHERE c."id" = NEW."clientId" AND c."tenantId" = NEW."tenantId" AND c."createdByDealerId" = NEW."dealerId"))
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal''s borrower was captured by that dealer';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM "FinancedAsset" a WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId" AND a."createdByDealerId" = NEW."dealerId"
    ) THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer deal''s asset was captured by that dealer';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."dealerId" IS DISTINCT FROM OLD."dealerId" OR NEW."dealerUserId" IS DISTINCT FROM OLD."dealerUserId" THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A deal''s dealer is fixed when it is created';
  END IF;
  IF NEW."dealerSubmittedAt" IS DISTINCT FROM OLD."dealerSubmittedAt"
    AND (OLD."dealerSubmittedAt" IS NOT NULL OR OLD."status" <> 'DRAFT' OR NEW."status" <> 'DRAFT') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer submits a deal once, while it is DRAFT';
  END IF;
  IF ROW(NEW."dealerCommissionSource", NEW."dealerCommissionRateId", NEW."dealerCommissionBps", NEW."dealerCommissionFlatCents",
      NEW."dealerCommissionBaseCents", NEW."dealerCommissionSnapshotAt")
    IS DISTINCT FROM ROW(OLD."dealerCommissionSource", OLD."dealerCommissionRateId", OLD."dealerCommissionBps", OLD."dealerCommissionFlatCents",
      OLD."dealerCommissionBaseCents", OLD."dealerCommissionSnapshotAt") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'The commission snapshot is the database''s: taken when the deal is approved, never changed';
  END IF;
  IF NEW."dealerId" IS NOT NULL AND NEW."status" = 'APPROVED' AND OLD."status" IS DISTINCT FROM 'APPROVED' THEN
    SELECT * INTO rate FROM "dealerCommissionRateAt"(NEW."tenantId", NEW."dealerId", today);
    NEW."dealerCommissionSource" := rate."source";
    NEW."dealerCommissionRateId" := rate."rateId";
    NEW."dealerCommissionBps" := rate."bps";
    NEW."dealerCommissionFlatCents" := rate."flatCents";
    -- The goods advance: what the asset costs the lender (cash price incl.
    -- VAT) less what the borrower brings (deposit, trade-in). Never the
    -- financed fees, never the interest: commission must not depend on them.
    NEW."dealerCommissionBaseCents" := (
      SELECT (a."cashPriceExclVatCents"::BIGINT + a."vatCents" - NEW."depositCents" - NEW."tradeInCents")::INTEGER
      FROM "FinancedAsset" a
      WHERE a."id" = NEW."assetId" AND a."tenantId" = NEW."tenantId"
    );
    NEW."dealerCommissionSnapshotAt" := CURRENT_TIMESTAMP;
  END IF;
  RETURN NEW;
END;
$function$;

-- A dealer deal moves on only after the hand-over ------------------------------

-- The staff accept (lib/dealer/submit.ts) runs submitDeal only once the
-- dealer has set dealerSubmittedAt; this makes that the database's rule. Staff
-- may still cancel an unsubmitted dealer draft.
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_dealer_handover" CHECK (
  "dealerId" IS NULL OR "status" IN ('DRAFT', 'CANCELLED') OR "dealerSubmittedAt" IS NOT NULL
);

-- Dealer user emails are lower case -------------------------------------------

-- The app lower-cases them; the unique (tenantId, email) is then unique
-- whatever the case a raw write uses.
ALTER TABLE "DealerUser" ADD CONSTRAINT "DealerUser_email_lower_case" CHECK ("email" = lower("email"));

-- A dealer attests consent only for a person it captured --------------------

-- A person the lender linked to a dealer's entity is the lender's to ask for
-- consent; the dealer neither names nor attests for them.
CREATE OR REPLACE FUNCTION "guardDealerConsentSubjectCaptured"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "AssetFinanceDeal" d JOIN "Client" c ON c."id" = NEW."clientId" AND c."tenantId" = d."tenantId"
    WHERE d."id" = NEW."dealId" AND d."tenantId" = NEW."tenantId" AND c."createdByDealerId" = d."dealerId"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer attests consent only for a person that dealer captured';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "DealerConsentAttestation_subject_captured" BEFORE INSERT ON "DealerConsentAttestation"
  FOR EACH ROW EXECUTE FUNCTION "guardDealerConsentSubjectCaptured"();

-- Contact details a dealer typed are untrusted until staff verify them --------

-- Until then the portal cannot be activated on them: no portal password is
-- set. A staff member verifies once (lib/dealer/contact-verification.ts); the
-- verification is never changed or cleared, and exists only on a client a
-- dealer captured.
ALTER TABLE "Client" ADD CONSTRAINT "Client_dealer_contact_verification_complete"
  CHECK (("dealerContactVerifiedAt" IS NULL) = ("dealerContactVerifiedById" IS NULL));
ALTER TABLE "Client" ADD CONSTRAINT "Client_dealer_contact_verification_dealer_only"
  CHECK ("dealerContactVerifiedAt" IS NULL OR "createdByDealerId" IS NOT NULL);

CREATE OR REPLACE FUNCTION "guardClientDealerContact"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."dealerContactVerifiedAt" IS NOT NULL OR NEW."dealerContactVerifiedById" IS NOT NULL THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Contact details are verified by staff after the dealer captured them';
    END IF;
  ELSIF OLD."dealerContactVerifiedAt" IS NOT NULL AND (
    NEW."dealerContactVerifiedAt" IS DISTINCT FROM OLD."dealerContactVerifiedAt"
    OR NEW."dealerContactVerifiedById" IS DISTINCT FROM OLD."dealerContactVerifiedById"
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A dealer-captured client''s contact details are verified once';
  END IF;
  IF NEW."createdByDealerId" IS NOT NULL AND NEW."dealerContactVerifiedAt" IS NULL AND NEW."portalPassword" IS NOT NULL
    AND (TG_OP = 'INSERT' OR NEW."portalPassword" IS DISTINCT FROM OLD."portalPassword") THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'No portal password until staff verify the contact details a dealer captured';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "Client_dealer_contact_guard" BEFORE INSERT OR UPDATE OF "portalPassword", "dealerContactVerifiedAt", "dealerContactVerifiedById"
  ON "Client" FOR EACH ROW EXECUTE FUNCTION "guardClientDealerContact"();

-- The VAT-vendor dealer's tax invoice, at release -----------------------------

-- A run that carries VAT is released only with the dealer's own tax invoice
-- (number and date: the lender's input-tax evidence); both parts together,
-- non-blank, and only on a RELEASED run. Released runs never change
-- (guardDealerPayableRun). A recipient-created tax invoice is not supported.
ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_tax_invoice_shape" CHECK (
  ("dealerTaxInvoiceReference" IS NULL) = ("dealerTaxInvoiceDate" IS NULL)
  AND ("dealerTaxInvoiceReference" IS NULL OR ("status" = 'RELEASED' AND char_length(btrim("dealerTaxInvoiceReference")) BETWEEN 1 AND 100))
);
ALTER TABLE "DealerPayableRun" ADD CONSTRAINT "DealerPayableRun_tax_invoice_on_vat" CHECK (
  "status" <> 'RELEASED' OR "totalVatCents" = 0 OR "dealerTaxInvoiceReference" IS NOT NULL
);
