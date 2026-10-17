-- CreateEnum
CREATE TYPE "StatementAiKind" AS ENUM ('SUMMARY', 'FLAG_EXPLANATION', 'ANSWER');

-- CreateEnum
CREATE TYPE "StatementAiStatus" AS ENUM ('PENDING', 'OK', 'REJECTED', 'FAILED');

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "featureStatementAi" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "StatementAiOutput" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" "StatementAiKind" NOT NULL,
    "flagCode" TEXT NOT NULL DEFAULT '',
    "inputHash" TEXT NOT NULL,
    "promptVersion" TEXT NOT NULL,
    "status" "StatementAiStatus" NOT NULL,
    "rejectReason" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "citations" JSONB NOT NULL DEFAULT '[]',
    "question" TEXT,
    "askedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatementAiOutput_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementAiUsage" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicationId" TEXT NOT NULL,
    "kind" "StatementAiKind" NOT NULL,
    "tokensIn" INTEGER,
    "tokensOut" INTEGER,
    "latencyMs" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StatementAiUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "StatementAiOutput_tenantId_applicationId_kind_createdAt_idx" ON "StatementAiOutput"("tenantId", "applicationId", "kind", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "StatementAiOutput_tenantId_applicationId_kind_flagCode_inpu_key" ON "StatementAiOutput"("tenantId", "applicationId", "kind", "flagCode", "inputHash", "promptVersion");

-- CreateIndex
CREATE INDEX "StatementAiUsage_tenantId_createdAt_idx" ON "StatementAiUsage"("tenantId", "createdAt");

-- AddForeignKey
ALTER TABLE "StatementAiOutput" ADD CONSTRAINT "StatementAiOutput_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementAiOutput" ADD CONSTRAINT "StatementAiOutput_tenantId_applicationId_fkey" FOREIGN KEY ("tenantId", "applicationId") REFERENCES "LoanApplication"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StatementAiOutput" ADD CONSTRAINT "StatementAiOutput_tenantId_askedById_fkey" FOREIGN KEY ("tenantId", "askedById") REFERENCES "User"("tenantId", "id") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "StatementAiUsage" ADD CONSTRAINT "StatementAiUsage_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
