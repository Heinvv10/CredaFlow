/**
 * Whether a tenant may change TenantConfig.collectionProvider now.
 *
 * Refused while the current provider still holds a non-terminal mandate or an
 * open debit instruction: status polling, submission and result fetching
 * run against the tenant's current provider, so switching away would strand
 * live mandates and in-flight debits at the old one. Cancel or finish them
 * first. Setting the first provider, or saving the same one, is never blocked.
 */
import type { CollectionInstructionStatus, DebitMandateStatus } from "@prisma/client"
import { prisma } from "@/lib/prisma"

const NON_TERMINAL_MANDATE: DebitMandateStatus[] = ["CREATED", "SUBMITTING", "PENDING_REGISTRATION", "PENDING_AUTH", "ACTIVE", "SUSPENDED"]
const OPEN_INSTRUCTION: CollectionInstructionStatus[] = ["PENDING", "SUBMITTING", "UPLOADED", "SUBMITTED", "NEEDS_REVIEW"]

export interface ProviderSwitchBlockers {
  current: string
  mandates: number
  instructions: number
}

export async function providerSwitchBlockers(tenantId: string, next: string | null): Promise<ProviderSwitchBlockers | null> {
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { collectionProvider: true } })
  const current = config?.collectionProvider ?? null
  if (!current || current === next) return null
  const [mandates, instructions] = await Promise.all([
    prisma.debitMandate.count({ where: { tenantId, provider: current, status: { in: NON_TERMINAL_MANDATE } } }),
    prisma.collectionInstruction.count({ where: { tenantId, mandate: { provider: current }, status: { in: OPEN_INSTRUCTION } } }),
  ])
  return mandates + instructions > 0 ? { current, mandates, instructions } : null
}
