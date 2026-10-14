// The tenant's bureau settings as the director/trustee check (./deal-bureau.ts)
// uses them, and the reuse window: a person's stored check is current for the
// tenant's bureau freshness window (TenantConfig.bureauMaxAgeDays).
import { prisma } from "@/lib/prisma"
import { bureauCheckMatchesSubject } from "@/lib/compliance/bureau-subject"
import { bureauMaxAgeDays } from "@/lib/compliance/bureau"
import { bureauProviderOrder } from "@/lib/bureau/registry"

export const DAY_MS = 24 * 60 * 60 * 1000

export interface DealBureauConfig {
  order: string[]
  credentials: string | null
  windowDays: number
}

export async function dealBureauConfig(tenantId: string): Promise<DealBureauConfig> {
  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { bureauProviderOrder: true, bureauCredentials: true, bureauMaxAgeDays: true },
  })
  return {
    // No config row keeps the schema default: Experian only.
    order: bureauProviderOrder(config ?? { bureauProviderOrder: ["experian"] }),
    credentials: config?.bureauCredentials ?? null,
    windowDays: bureauMaxAgeDays(config),
  }
}

/** A person checked for this application within this many days is not checked again unless the run is forced. */
export async function dealRecheckWindowDays(tenantId: string): Promise<number> {
  const config = await prisma.tenantConfig.findUnique({ where: { tenantId }, select: { bureauMaxAgeDays: true } })
  return bureauMaxAgeDays(config)
}

/**
 * Of `clientIds`, those with a successful check stored for this application
 * within the last `windowDays` (dealRecheckWindowDays). Each consumer enquiry
 * leaves a footprint on the person's credit record, so a re-run inside the
 * window needs `force`.
 */
export async function recentlyCheckedClientIds(
  tenantId: string,
  applicationId: string,
  clientIds: string[],
  windowDays: number,
  now: Date = new Date(),
): Promise<Set<string>> {
  if (clientIds.length === 0) return new Set()
  const [rows, clients] = await Promise.all([
    prisma.creditBureauCheck.findMany({
      where: {
        tenantId, applicationId, clientId: { in: clientIds }, ok: true,
        createdAt: { gte: new Date(now.getTime() - windowDays * DAY_MS) },
      },
      select: { clientId: true, subjectFingerprint: true },
    }),
    prisma.client.findMany({
      where: { tenantId, id: { in: clientIds } },
      select: { id: true, idNumber: true, firstName: true, lastName: true, gender: true, dateOfBirth: true },
    }),
  ])
  const current = new Map(clients.map((client) => [client.id, client]))
  return new Set(rows
    .filter((row) => {
      const client = current.get(row.clientId)
      return client ? bureauCheckMatchesSubject(row, client) : false
    })
    .map((row) => row.clientId))
}
