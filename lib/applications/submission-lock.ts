import { Prisma } from "@prisma/client"
import type { prisma as ScopedPrismaClient } from "@/lib/prisma"
import {
  lockAffordabilityApplicationEvidence,
  lockAffordabilityClientEvidence,
} from "@/lib/affordability/evidence-locks"

export type ApplicationSubmissionTransaction = Parameters<
  Parameters<typeof ScopedPrismaClient.$transaction>[0]
>[0]

async function lockClientAndProductRows(
  tx: ApplicationSubmissionTransaction,
  args: { tenantId: string; clientId: string; productId: string },
): Promise<boolean> {
  await lockAffordabilityClientEvidence(tx, {
    tenantId: args.tenantId,
    clientId: args.clientId,
  })

  // Client financial writers join the advisory lock above. The row locks also
  // bind the exact client and product versions read later in this transaction;
  // a product pricing update must wait until the application state commits.
  const clientRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "Client"
    WHERE "id" = ${args.clientId} AND "tenantId" = ${args.tenantId}
    FOR SHARE
  `)
  if (!clientRows[0]) return false

  const productRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "LoanProduct"
    WHERE "id" = ${args.productId} AND "tenantId" = ${args.tenantId}
    FOR SHARE
  `)
  return Boolean(productRows[0])
}

/** Lock the evidence rows for a new application before rebuilding its snapshot. */
export async function lockNewApplicationSubmissionEvidence(
  tx: ApplicationSubmissionTransaction,
  args: { tenantId: string; clientId: string; productId: string },
): Promise<boolean> {
  return lockClientAndProductRows(tx, args)
}

export interface LockedApplicationIdentity {
  id: string
  clientId: string
  productId: string
  evidenceExists: boolean
}

type ApplicationIdentityRow = Omit<LockedApplicationIdentity, "evidenceExists">

/**
 * Lock an existing application first, then the target client and product in
 * the same order used by approval/disbursement evidence checks.
 */
export async function lockExistingApplicationSubmissionEvidence(
  tx: ApplicationSubmissionTransaction,
  args: {
    tenantId: string
    applicationId: string
    clientId?: string
    productId?: string
  },
): Promise<LockedApplicationIdentity | null> {
  await lockAffordabilityApplicationEvidence(tx, {
    tenantId: args.tenantId,
    applicationId: args.applicationId,
  })

  const rows = await tx.$queryRaw<ApplicationIdentityRow[]>(Prisma.sql`
    SELECT "id", "clientId", "productId"
    FROM "LoanApplication"
    WHERE "id" = ${args.applicationId} AND "tenantId" = ${args.tenantId}
    FOR UPDATE
  `)
  const application = rows[0]
  if (!application) return null

  const evidenceExists = await lockClientAndProductRows(tx, {
    tenantId: args.tenantId,
    clientId: args.clientId ?? application.clientId,
    productId: args.productId ?? application.productId,
  })
  return { ...application, evidenceExists }
}
