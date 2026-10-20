-- CreateEnum
CREATE TYPE "CronRunStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "CronRunClaim" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "finishedAt" TIMESTAMP(3),
ADD COLUMN     "status" "CronRunStatus" NOT NULL DEFAULT 'RUNNING';
