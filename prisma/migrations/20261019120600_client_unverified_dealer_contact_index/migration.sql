-- Slice 5 part A, review round 3 (architecture, LOW). Hand-written: Prisma
-- cannot express a partial index, and `prisma migrate diff` leaves it alone.
--
-- The trust checks on dealer-typed contacts (lib/clients/dealer-contact.ts,
-- guardDealerDealContactsVerified, the portal and servicing selectors) look
-- for clients a dealer captured that staff have not verified. They are few:
-- index only those rows.
CREATE INDEX "Client_unverified_dealer_contact_idx" ON "Client" ("tenantId")
  WHERE "createdByDealerId" IS NOT NULL AND "dealerContactVerifiedAt" IS NULL;
