-- Borrowers are per lender (W0): the same person may be a client of two
-- lenders on one platform. Client.idNumber and Client.email were unique across
-- the whole database; they are now unique within a tenant. The new indexes are
-- implied by the old ones, so no existing row can violate them.
DROP INDEX "Client_idNumber_key";
DROP INDEX "Client_email_key";
CREATE UNIQUE INDEX "Client_tenantId_idNumber_key" ON "Client"("tenantId", "idNumber");
CREATE UNIQUE INDEX "Client_tenantId_email_key" ON "Client"("tenantId", "email");
