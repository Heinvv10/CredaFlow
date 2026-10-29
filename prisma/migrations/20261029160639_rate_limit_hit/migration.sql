-- CreateTable
CREATE TABLE "RateLimitHit" (
    "keyHash" TEXT NOT NULL,
    "ns" TEXT NOT NULL DEFAULT '',
    "hits" TIMESTAMPTZ(3)[],
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("keyHash")
);

-- CreateIndex
CREATE INDEX "RateLimitHit_expiresAt_idx" ON "RateLimitHit"("expiresAt");

-- CreateIndex
CREATE INDEX "RateLimitHit_ns_expiresAt_idx" ON "RateLimitHit"("ns", "expiresAt");

-- Every hit rewrites its row (and moves "expiresAt" in an index, so the update is never HOT): this table is
-- all churn. Vacuum it by a small fraction of its rows instead of the default 20%.
ALTER TABLE "RateLimitHit" SET (autovacuum_vacuum_scale_factor = 0.01, autovacuum_vacuum_threshold = 500, autovacuum_analyze_scale_factor = 0.05);
