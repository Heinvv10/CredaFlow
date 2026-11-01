-- A signing code goes to a ContactIdentity, so whoever sets that identity can receive the code. A value staff set
-- is therefore unverified for signing until someone else confirms it: a different staff member (recorded and audited)
-- or the borrower in their own authenticated portal session (lib/contact/identity-confirmation.ts). A value the
-- borrower set themselves carries no setter and counts as verified.
--
-- No backfill: every existing row has a null setter and counts as verified. Additive and nullable; the CHECK cannot
-- reject a row the running code writes, because nothing writes these columns before this ships. Ordinary messages
-- do not read them.
--
-- Rollback (hand-written): ALTER TABLE "ContactIdentity" DROP CONSTRAINT "ContactIdentity_confirmation", then DROP the four columns.

ALTER TABLE "ContactIdentity" ADD COLUMN "setByStaffUserId" TEXT;
ALTER TABLE "ContactIdentity" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "ContactIdentity" ADD COLUMN "confirmedByUserId" TEXT;
ALTER TABLE "ContactIdentity" ADD COLUMN "confirmedByClientId" TEXT;

-- Confirmed by exactly one party, only a staff-set value is ever confirmed, and never by the person who set it.
ALTER TABLE "ContactIdentity" ADD CONSTRAINT "ContactIdentity_confirmation" CHECK (
  (
    ("confirmedAt" IS NULL AND "confirmedByUserId" IS NULL AND "confirmedByClientId" IS NULL)
    OR ("confirmedAt" IS NOT NULL AND "setByStaffUserId" IS NOT NULL AND (("confirmedByUserId" IS NULL) <> ("confirmedByClientId" IS NULL)))
  )
  AND ("confirmedByUserId" IS NULL OR "confirmedByUserId" <> "setByStaffUserId")
);
