-- CreateTable
CREATE TABLE "CronRunClaim" (
    "job" TEXT NOT NULL,
    "runDay" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CronRunClaim_pkey" PRIMARY KEY ("job","runDay")
);
