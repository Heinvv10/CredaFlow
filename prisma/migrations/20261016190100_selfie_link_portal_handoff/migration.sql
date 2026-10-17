-- Fair Score audit 2026-10-16 (workstream D): a borrower whose computer has no
-- camera continues the KYC selfie on their phone. The signed-in client mints
-- the same one-time capture link staff send (lib/kyc/selfie-link-token.server.ts),
-- shown as a QR code in the portal: no staff member issued it, so the issuer
-- may be null, and only on a PORTAL link. Every existing row has an issuer and
-- a staff channel, so the CHECK holds for them and for the running code.

-- AlterTable
ALTER TABLE "SelfieCaptureToken" ALTER COLUMN "createdById" DROP NOT NULL;

ALTER TABLE "SelfieCaptureToken" ADD CONSTRAINT "SelfieCaptureToken_issuer_matches_channel"
  CHECK (("createdById" IS NULL) = ("channel" = 'PORTAL'));
