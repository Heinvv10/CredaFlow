-- A signing code goes to a ContactIdentity, so whoever sets that identity can receive the code. A value staff set
-- is therefore unverified for signing, and for recovering the portal login, until a different staff member confirms it
-- (recorded and audited, lib/contact/identity-confirmation.ts). The borrower cannot: a session reached through that very
-- address proves nothing. A value the borrower set themselves carries no setter and counts as verified.
--
-- No backfill: every existing row has a null setter and counts as verified. Additive and nullable; the CHECK cannot
-- reject a row the running code writes, because nothing writes these columns before this ships. Ordinary messages
-- do not read them.
--
-- Rollback (hand-written): ALTER TABLE "ContactIdentity" DROP CONSTRAINT "ContactIdentity_confirmation", then DROP the three columns.

ALTER TABLE "ContactIdentity" ADD COLUMN "setByStaffUserId" TEXT;
ALTER TABLE "ContactIdentity" ADD COLUMN "confirmedAt" TIMESTAMP(3);
ALTER TABLE "ContactIdentity" ADD COLUMN "confirmedByUserId" TEXT;

-- Confirmed whole, only a staff-set value is ever confirmed, and never by the person who set it.
ALTER TABLE "ContactIdentity" ADD CONSTRAINT "ContactIdentity_confirmation" CHECK (
  ("confirmedAt" IS NULL AND "confirmedByUserId" IS NULL)
  OR ("confirmedAt" IS NOT NULL AND "setByStaffUserId" IS NOT NULL AND "confirmedByUserId" IS NOT NULL AND "confirmedByUserId" <> "setByStaffUserId")
);
