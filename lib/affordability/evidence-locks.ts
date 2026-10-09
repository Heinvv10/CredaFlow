import { Prisma } from "@prisma/client"

export interface AffordabilityEvidenceLockTransaction {
  $queryRaw<T = unknown>(query: Prisma.Sql): Promise<T>
}

/**
 * Serialize writes that can change application-scoped lending evidence.
 *
 * Credit-bureau and AVS result tables deliberately do not have an application
 * foreign key, so row locks on LoanApplication cannot coordinate their inserts.
 */
export async function lockAffordabilityApplicationEvidence(
  tx: AffordabilityEvidenceLockTransaction,
  args: { tenantId: string; applicationId: string },
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`affordability-application:${args.tenantId}:${args.applicationId}`})
    )::text AS "lockResult"
  `)
}

/**
 * Serialize client-document and AVS mutations with the payout transaction.
 * This also keeps a physical document deletion from racing past the database
 * row locks held by disbursement.
 */
export async function lockAffordabilityClientEvidence(
  tx: AffordabilityEvidenceLockTransaction,
  args: { tenantId: string; clientId: string },
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`affordability-client:${args.tenantId}:${args.clientId}`})
    )::text AS "lockResult"
  `)
}

/**
 * A row lock cannot protect the schema-default case where TenantConfig has not
 * been created yet. Every writer that can affect a lending gate takes this
 * tenant-scoped lock before its upsert.
 */
export async function lockAffordabilityTenantPolicy(
  tx: AffordabilityEvidenceLockTransaction,
  args: { tenantId: string },
): Promise<void> {
  await tx.$queryRaw(Prisma.sql`
    SELECT pg_advisory_xact_lock(
      hashtext(${`affordability-tenant-policy:${args.tenantId}`})
    )::text AS "lockResult"
  `)
}
