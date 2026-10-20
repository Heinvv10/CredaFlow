-- CreateIndex
CREATE INDEX "Loan_clientId_idx" ON "Loan"("clientId");

-- The per-send dunning hold asks "is any loan of this client under debt review"
-- (lib/collections/dunning-holds.ts, client-holds.ts). Few loans carry a notice,
-- so a partial index keeps that lookup, and the "who is under debt review" scan,
-- off the whole table. Hand-written: Prisma's schema language cannot express a
-- partial index.
CREATE INDEX "Loan_debtReviewNoticeAt_idx" ON "Loan"("debtReviewNoticeAt") WHERE "debtReviewNoticeAt" IS NOT NULL;
