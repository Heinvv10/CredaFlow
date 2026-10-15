-- CreateEnum
CREATE TYPE "SigningOtpPurpose" AS ENUM ('AGREEMENT', 'DEBIT_MANDATE', 'DOCUMENT', 'DEAL_DOCUMENT');

-- AlterTable
ALTER TABLE "TenantConfig" ADD COLUMN     "allowNewRegistrations" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "requireSigningOtp" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "signingOtpBranchExempt" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "staffAccessHours" JSONB,
ADD COLUMN     "staffIpAllowlist" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable
CREATE TABLE "SigningOtpChallenge" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "purpose" "SigningOtpPurpose" NOT NULL,
    "subjectId" TEXT NOT NULL,
    "documentSha256" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "channel" "Channel" NOT NULL,
    "maskedDestination" TEXT NOT NULL,
    "deliveryStatus" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "consumedAt" TIMESTAMP(3),
    "signingMethod" TEXT,
    "requestedByUserId" TEXT,
    "requestedIp" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SigningOtpChallenge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "SigningOtpChallenge_tenantId_clientId_purpose_subjectId_cre_idx" ON "SigningOtpChallenge"("tenantId", "clientId", "purpose", "subjectId", "createdAt");

-- AddForeignKey
ALTER TABLE "SigningOtpChallenge" ADD CONSTRAINT "SigningOtpChallenge_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SigningOtpChallenge" ADD CONSTRAINT "SigningOtpChallenge_tenantId_clientId_fkey" FOREIGN KEY ("tenantId", "clientId") REFERENCES "Client"("tenantId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written enforcement (Prisma does not diff anything below).
--
-- Enforcement here is on a NEW table only; the TenantConfig columns are
-- additive with defaults. requireSigningOtp defaults to true, so the signing
-- routes demand a verified code from the moment the code that reads it ships:
-- this migration and lib/signing-otp ship together.
-- ---------------------------------------------------------------------------

-- SMS is off by policy (lib/messaging/.claude.md): a signing code may only
-- ever travel by email or WhatsApp.
ALTER TABLE "SigningOtpChallenge" ADD CONSTRAINT "SigningOtpChallenge_channel_check"
  CHECK ("channel" IN ('EMAIL', 'WHATSAPP'));
-- PENDING: the row is written (and counted against the request budget) before
-- the send; the send's outcome then settles it once.
ALTER TABLE "SigningOtpChallenge" ADD CONSTRAINT "SigningOtpChallenge_delivery_check"
  CHECK (
    ("deliveryStatus" IN ('ACCEPTED', 'SIMULATED') AND "sentAt" IS NOT NULL)
    OR ("deliveryStatus" IN ('PENDING', 'FAILED') AND "sentAt" IS NULL)
  );
ALTER TABLE "SigningOtpChallenge" ADD CONSTRAINT "SigningOtpChallenge_document_sha256_check"
  CHECK ("documentSha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "SigningOtpChallenge" ADD CONSTRAINT "SigningOtpChallenge_attempts_check"
  CHECK ("maxAttempts" BETWEEN 1 AND 10 AND "attempts" BETWEEN 0 AND "maxAttempts");
-- A code is verified before it expires, by an attempt, and only a verified
-- code is consumed by a signature (portal or branch).
ALTER TABLE "SigningOtpChallenge" ADD CONSTRAINT "SigningOtpChallenge_verified_check"
  CHECK ("verifiedAt" IS NULL OR ("verifiedAt" <= "expiresAt" AND "attempts" >= 1 AND "deliveryStatus" IN ('ACCEPTED', 'SIMULATED')));
ALTER TABLE "SigningOtpChallenge" ADD CONSTRAINT "SigningOtpChallenge_consumed_check"
  CHECK (
    ("consumedAt" IS NULL AND "signingMethod" IS NULL)
    OR ("consumedAt" IS NOT NULL AND "verifiedAt" IS NOT NULL AND "signingMethod" IN ('portal', 'branch'))
  );

-- The row is written PENDING before the send, and the send's outcome
-- (deliveryStatus, sentAt) is recorded once. After that only the attempt
-- counter may rise, and verification and consumption may each be recorded
-- once. A consumed row is the OTP evidence of a signature and is frozen,
-- delete included.
CREATE OR REPLACE FUNCTION "guardSigningOtpChallenge"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  mutable_columns TEXT[] := ARRAY['attempts', 'verifiedAt', 'consumedAt', 'signingMethod'];
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."deliveryStatus" = 'PENDING' AND NEW."deliveryStatus" <> 'PENDING' THEN
    mutable_columns := mutable_columns || ARRAY['deliveryStatus', 'sentAt'];
  END IF;
  IF TG_OP = 'DELETE' THEN
    IF OLD."consumedAt" IS NOT NULL THEN
      RAISE EXCEPTION 'SigningOtpChallenge %: a consumed signing OTP is signature evidence and cannot be deleted', OLD."id"
        USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
  IF OLD."consumedAt" IS NOT NULL THEN
    RAISE EXCEPTION 'SigningOtpChallenge %: a consumed signing OTP is signature evidence and cannot be changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF (to_jsonb(NEW) - mutable_columns) IS DISTINCT FROM (to_jsonb(OLD) - mutable_columns) THEN
    RAISE EXCEPTION 'SigningOtpChallenge %: the binding, code and delivery evidence cannot be changed', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."attempts" < OLD."attempts" THEN
    RAISE EXCEPTION 'SigningOtpChallenge %: the attempt counter cannot go down', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."verifiedAt" IS NOT NULL AND NEW."verifiedAt" IS DISTINCT FROM OLD."verifiedAt" THEN
    RAISE EXCEPTION 'SigningOtpChallenge %: verification is recorded once', OLD."id"
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "SigningOtpChallenge_guard"
  BEFORE UPDATE OR DELETE ON "SigningOtpChallenge"
  FOR EACH ROW EXECUTE FUNCTION "guardSigningOtpChallenge"();
