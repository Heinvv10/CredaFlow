-- CreateEnum
CREATE TYPE "CronRunStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "CronRunClaim" (
    "job" TEXT NOT NULL,
    "runDay" TEXT NOT NULL,
    "claimedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "status" "CronRunStatus" NOT NULL DEFAULT 'RUNNING',
    "finishedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "ownerToken" TEXT,

    CONSTRAINT "CronRunClaim_pkey" PRIMARY KEY ("job","runDay")
);

-- CreateTable
CREATE TABLE "SendReservation" (
    "key" TEXT NOT NULL,
    "runDay" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SendReservation_pkey" PRIMARY KEY ("key","runDay")
);

-- CreateIndex
CREATE INDEX "SendReservation_tenantId_idx" ON "SendReservation"("tenantId");
