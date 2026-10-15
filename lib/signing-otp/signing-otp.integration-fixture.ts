/**
 * For integration suites that exercise a signing route for some other rule:
 * a challenge already sent and verified, exactly as the request + verify
 * endpoints leave it, so the route's OTP gate is satisfied for real (checked
 * and spent in its transaction) rather than switched off. The OTP lifecycle
 * itself is proven in challenge.integration.test.ts.
 */
import { randomUUID } from "node:crypto"
import type { PrismaClient, SigningOtpPurpose } from "@prisma/client"

export async function verifiedSigningOtp(
  db: Pick<PrismaClient, "signingOtpChallenge">,
  binding: { tenantId: string; clientId: string; purpose: SigningOtpPurpose; subjectId: string; documentSha256: string },
): Promise<string> {
  const id = randomUUID()
  const now = Date.now()
  await db.signingOtpChallenge.create({
    data: {
      id,
      ...binding,
      // Never compared: the challenge is created already verified.
      codeHash: "0".repeat(64),
      channel: "EMAIL",
      maskedDestination: "f***e@s***.invalid",
      deliveryStatus: "ACCEPTED",
      sentAt: new Date(now - 60_000),
      expiresAt: new Date(now + 240_000),
      attempts: 1,
      maxAttempts: 5,
      verifiedAt: new Date(now - 30_000),
    },
  })
  return id
}
