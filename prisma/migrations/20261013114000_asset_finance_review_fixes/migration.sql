-- AlterEnum
ALTER TYPE "PayoutStatus" ADD VALUE 'CANCELLED';

-- AlterTable
ALTER TABLE "AssetFinanceDeal" ADD COLUMN     "cancelReason" TEXT,
ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT,
ADD COLUMN     "plannedStartDate" DATE,
ADD COLUMN     "preparedSigners" JSONB,
ADD COLUMN     "signedArrearsMarginRate" DECIMAL(9,6),
ADD COLUMN     "signedBaseInstalmentCents" INTEGER,
ADD COLUMN     "signedCollectionFeeCents" INTEGER,
ADD COLUMN     "signedResultingRate" DECIMAL(9,6),
ADD COLUMN     "signedTotalInterestCents" INTEGER;

-- AlterTable
ALTER TABLE "Payout" ADD COLUMN     "cancelledAt" TIMESTAMP(3),
ADD COLUMN     "cancelledById" TEXT;

-- AlterTable
ALTER TABLE "PayoutChecklistItem" ADD COLUMN     "attestedIdentifier" TEXT;

-- AddForeignKey
ALTER TABLE "SupplierBankAccount" ADD CONSTRAINT "SupplierBankAccount_tenantId_requestedById_fkey" FOREIGN KEY ("tenantId", "requestedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "SupplierBankAccount" ADD CONSTRAINT "SupplierBankAccount_tenantId_decidedById_fkey" FOREIGN KEY ("tenantId", "decidedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_tenantId_cancelledById_fkey" FOREIGN KEY ("tenantId", "cancelledById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Payout" ADD CONSTRAINT "Payout_tenantId_cancelledById_fkey" FOREIGN KEY ("tenantId", "cancelledById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- ---------------------------------------------------------------------------
-- Hand-written (asset finance review fixes: deal lifecycle and contract terms)
-- ---------------------------------------------------------------------------

-- The contract terms fixed at document preparation
-- (lib/asset-finance/signing-prepare.ts) are written whole: the planned start,
-- the figures the agreement prints, the arrears terms and the required signer
-- set. The start falls before the first instalment.
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_signed_terms_complete" CHECK (
  num_nulls("plannedStartDate", "signedBaseInstalmentCents", "signedResultingRate", "signedTotalInterestCents",
    "signedArrearsMarginRate", "signedCollectionFeeCents", "preparedSigners") IN (0, 7)
);
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_planned_start_before_first_due" CHECK (
  "plannedStartDate" IS NULL OR "plannedStartDate" < "firstDueDate"
);
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_signed_terms_range" CHECK (
  ("signedBaseInstalmentCents" IS NULL OR "signedBaseInstalmentCents" >= 0)
  AND ("signedTotalInterestCents" IS NULL OR "signedTotalInterestCents" >= 0)
  AND ("signedResultingRate" IS NULL OR ("signedResultingRate" >= 0 AND "signedResultingRate" <= 1))
  AND ("signedArrearsMarginRate" IS NULL OR "signedArrearsMarginRate" >= 0)
  AND ("signedCollectionFeeCents" IS NULL OR "signedCollectionFeeCents" >= 0)
);

-- A cancelled deal says who cancelled it, when and why (at least 10
-- characters); no other deal carries a cancellation.
ALTER TABLE "AssetFinanceDeal" ADD CONSTRAINT "AssetFinanceDeal_cancellation_shape" CHECK (
  ("status" = 'CANCELLED' AND "cancelledAt" IS NOT NULL AND "cancelledById" IS NOT NULL
    AND "cancelReason" IS NOT NULL AND length(btrim("cancelReason")) >= 10)
  OR ("status" <> 'CANCELLED' AND "cancelledAt" IS NULL AND "cancelledById" IS NULL AND "cancelReason" IS NULL)
);

-- The deal status table. A deal is created DRAFT. From there:
--   DRAFT       → SUBMITTED | REFUSED_NCA (refused at submit) | CANCELLED
--   SUBMITTED   → APPROVED | DECLINED | REFERRED | REFUSED_NCA | CANCELLED
--   REFERRED    → APPROVED | DECLINED | REFUSED_NCA | CANCELLED
--   APPROVED    → CONTRACTED | CANCELLED
--   CONTRACTED  → BOOKED | CANCELLED
-- BOOKED, DECLINED, REFUSED_NCA and CANCELLED are terminal. The CONTRACTED
-- and BOOKED moves have their own gates (guardAssetDealContract,
-- guardAssetDealBooking). Mirrors lib/asset-finance/deal-cancel.ts
-- CANCELLABLE_DEAL_STATUSES for the cancel moves.
CREATE OR REPLACE FUNCTION public."guardAssetDealStatus"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'DRAFT' THEN
      RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'An asset deal is created DRAFT';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" IS NOT DISTINCT FROM OLD."status" THEN
    RETURN NEW;
  END IF;
  IF NOT (
    (OLD."status" = 'DRAFT' AND NEW."status" IN ('SUBMITTED', 'REFUSED_NCA', 'CANCELLED'))
    OR (OLD."status" = 'SUBMITTED' AND NEW."status" IN ('APPROVED', 'DECLINED', 'REFERRED', 'REFUSED_NCA', 'CANCELLED'))
    OR (OLD."status" = 'REFERRED' AND NEW."status" IN ('APPROVED', 'DECLINED', 'REFUSED_NCA', 'CANCELLED'))
    OR (OLD."status" = 'APPROVED' AND NEW."status" IN ('CONTRACTED', 'CANCELLED'))
    OR (OLD."status" = 'CONTRACTED' AND NEW."status" IN ('BOOKED', 'CANCELLED'))
  ) THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = format('An asset deal cannot move from %s to %s', OLD."status", NEW."status");
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_status_transitions" BEFORE INSERT OR UPDATE OF "status" ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."guardAssetDealStatus"();

-- A BOOKED deal is the record of what was booked: no column changes any more
-- (updatedAt aside). Named to fire after AssetFinanceDeal_booking_gate, whose
-- message covers a change of status or loan.
CREATE OR REPLACE FUNCTION public."freezeBookedAssetDeal"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD."status" = 'BOOKED' AND (to_jsonb(NEW) - 'updatedAt') IS DISTINCT FROM (to_jsonb(OLD) - 'updatedAt') THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'A booked deal is immutable: its money, structure, asset and terms are what was booked';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "AssetFinanceDeal_frozen_when_booked" BEFORE UPDATE ON "AssetFinanceDeal"
  FOR EACH ROW EXECUTE FUNCTION public."freezeBookedAssetDeal"();

-- An entity document is bound to its bytes, its entity and deal, and its
-- uploader when it is written. Verification and soft deletion are the only
-- changes (their own columns).
CREATE OR REPLACE FUNCTION public."guardEntityDocumentBinding"()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF NEW."storagePath" IS DISTINCT FROM OLD."storagePath"
    OR NEW."contentSha256" IS DISTINCT FROM OLD."contentSha256"
    OR NEW."dealId" IS DISTINCT FROM OLD."dealId"
    OR NEW."entityId" IS DISTINCT FROM OLD."entityId"
    OR NEW."uploadedById" IS DISTINCT FROM OLD."uploadedById"
    OR NEW."uploadedByType" IS DISTINCT FROM OLD."uploadedByType"
  THEN
    RAISE EXCEPTION USING ERRCODE = '23514',
      MESSAGE = 'An entity document''s bytes, entity, deal and uploader are fixed when it is written';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER "EntityDocument_binding_fixed" BEFORE UPDATE ON "EntityDocument"
  FOR EACH ROW EXECUTE FUNCTION public."guardEntityDocumentBinding"();
