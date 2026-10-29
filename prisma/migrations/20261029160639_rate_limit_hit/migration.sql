-- CreateTable
CREATE TABLE "RateLimitHit" (
    "keyHash" TEXT NOT NULL,
    "hits" TIMESTAMPTZ(3)[],
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "RateLimitHit_pkey" PRIMARY KEY ("keyHash")
);

-- CreateIndex
CREATE INDEX "RateLimitHit_expiresAt_idx" ON "RateLimitHit"("expiresAt");
