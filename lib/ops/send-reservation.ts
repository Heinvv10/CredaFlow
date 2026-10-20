import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"

/**
 * A database-unique reservation for one borrower message (or escalation rule
 * action) per SAST day, taken BEFORE it is sent. A takeover of a run claim
 * (lib/ops/cron-run-claim.ts) can overlap a runner that only lost its heartbeat,
 * and both then pass the "already sent today" check before either has written its
 * marker; of two such runs only one gets `true` here.
 *
 * A reservation is kept once the send may have reached the provider, and given
 * back (`releaseReservation`) only when it definitely did not, so a retry can send.
 * `at` is the instant the reservation was taken: it names the SAST day the row
 * lives under, and the release must pass the same instant, so a run that finishes
 * after midnight cannot delete the next day's reservation.
 */
export async function reserveOnce(tenantId: string, key: string, at: Date): Promise<boolean> {
  const { count } = await prisma.sendReservation.createMany({
    data: [{ key, runDay: sastCalendarDate(at), tenantId }],
    skipDuplicates: true,
  })
  return count === 1
}

export async function releaseReservation(key: string, at: Date): Promise<void> {
  await prisma.sendReservation.deleteMany({ where: { key, runDay: sastCalendarDate(at) } })
}
