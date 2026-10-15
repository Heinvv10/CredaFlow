-- Collections engine, review round 4. Additive and nullable: safe ahead of the code.
-- CollectionInstruction.releasedAt: an instruction staff (or a provider NOT_FOUND)
-- released for sending again; a repeat PAID without a provider result id may then
-- be a second, real debit and is reviewed instead of deduplicated.
-- DebitMandate.providerSuspendReportedAt: the first of the two consecutive
-- SUSPENDED reports needed before an ACTIVE mandate is suspended.
ALTER TABLE "CollectionInstruction" ADD COLUMN "releasedAt" TIMESTAMP(3);
ALTER TABLE "DebitMandate" ADD COLUMN "providerSuspendReportedAt" TIMESTAMP(3);
