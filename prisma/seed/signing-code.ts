/**
 * A demo borrower's signing code (lib/signing-otp; the lender requires one by
 * default), as the request + verify endpoints leave it. No message leaves the
 * seed, so the evidence says so: SIMULATED, "seeded (no message sent)". There
 * is no code to hash (and the seed needs no AUTH_SECRET): the row is written
 * already verified, and the signing function spends it for real.
 */
import { randomUUID } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { SIGNING_OTP_MAX_ATTEMPTS, SIGNING_OTP_TTL_MS } from "@/lib/signing-otp/code"

export async function seedSigningCode(tenantId: string, clientId: string, signerId: string, documentSha256: string): Promise<string> {
  const id = randomUUID()
  const now = Date.now()
  await prisma.signingOtpChallenge.create({
    data: {
      id, tenantId, clientId, purpose: "DEAL_DOCUMENT", subjectId: signerId, documentSha256,
      codeHash: "0".repeat(64), channel: "EMAIL", maskedDestination: "seeded (no message sent)",
      deliveryStatus: "SIMULATED", sentAt: new Date(now), expiresAt: new Date(now + SIGNING_OTP_TTL_MS),
      maxAttempts: SIGNING_OTP_MAX_ATTEMPTS, attempts: 1, verifiedAt: new Date(now),
    },
  })
  return id
}
