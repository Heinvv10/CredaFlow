import type { Prisma } from "@prisma/client"
import { ConcurrentChangeError } from "./errors"

/** The borrower's portal never says why: whoever is at the keyboard is not the person this is about (as the portal's apply route). */
export const BORROWER_REFUSAL = "We cannot continue with this application. Please contact us."
export const STAFF_REFUSAL = "This client is recorded as deceased. Loan documents cannot be issued."

/**
 * Refuses inside the caller's transaction if the borrower is recorded as deceased. The client row is read under a share
 * lock, so a record of death either committed first and is seen here, or waits until this document step has committed.
 * Application then client, the order approval and review take, so the two cannot deadlock.
 */
export async function requireLivingBorrower(
  tx: Pick<Prisma.TransactionClient, "$queryRaw">,
  args: { tenantId: string; applicationId: string; clientId: string; refusal: string },
): Promise<void> {
  await tx.$queryRaw`SELECT "id" FROM "LoanApplication" WHERE "id" = ${args.applicationId} AND "tenantId" = ${args.tenantId} FOR UPDATE`
  const [client] = await tx.$queryRaw<{ deceasedAt: Date | null }[]>`
    SELECT "deceasedAt" FROM "Client" WHERE "id" = ${args.clientId} AND "tenantId" = ${args.tenantId} FOR SHARE`
  if (!client || client.deceasedAt) throw new ConcurrentChangeError(args.refusal)
}
