-- Collections engine, review round 2. Additive and nullable: safe ahead of the code.
-- DebitMandate.providerContactedAt: a mandate cancelled before the provider
-- returned a reference is looked up at the provider by our reference.
-- CollectionInstruction.reviewResolvedAt: staff acknowledgement of a REJECTED instruction.
ALTER TABLE "DebitMandate" ADD COLUMN "providerContactedAt" TIMESTAMP(3);
ALTER TABLE "CollectionInstruction" ADD COLUMN "reviewResolvedAt" TIMESTAMP(3);
