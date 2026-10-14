import { prisma } from "./prisma"

/**
 * Atomically claim a TOTP counter for replay protection.
 * Returns true if the counter was claimed (first use or later-counter login).
 * Returns false if the counter was already used (replay) or DB write failed.
 */
export async function claimTotpCounter(userId: string, matchedCounter: number): Promise<boolean> {
  const claimed = await prisma.user.updateMany({
    where: {
      id: userId,
      OR: [{ lastTotpCounter: null }, { lastTotpCounter: { lt: matchedCounter } }],
    },
    data: { lastTotpCounter: matchedCounter },
  })
  return claimed.count > 0
}
