/**
 * One run of a collections-engine cron across every tenant whose engine is on.
 * Tenants with collectionsEngineEnabled off are not read at all: for them the
 * run is a no-op, byte for byte.
 *
 *   SUBMIT  — refresh mandates with the provider, plan instructions from the
 *             schedules, submit what is due.
 *   RESULTS — fetch provider outcomes and act on them.
 */
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { errorSummary, loadEngineContext } from "./context"
import { refreshMandates, type RefreshSummary } from "./mandate-lifecycle"
import { planTenantInstructions, type PlanSummary } from "./instructions"
import { submitDueInstructions, type SubmitSummary } from "./submit"
import { ingestResults, type IngestSummary } from "./results"

export type CollectionsCronKind = "SUBMIT" | "RESULTS"

export type TenantCollectionsRun =
  | { tenantId: string; outcome: "SUBMIT"; mandates: RefreshSummary; planned: PlanSummary; submitted: SubmitSummary }
  | { tenantId: string; outcome: "RESULTS"; results: IngestSummary }
  | { tenantId: string; outcome: "SKIPPED"; reason: string }
  | { tenantId: string; outcome: "ERROR"; error: string }

export interface CollectionsCronRun {
  /** false when any tenant errored; the route turns that into a non-2xx */
  ok: boolean
  kind: CollectionsCronKind
  perTenant: TenantCollectionsRun[]
}

export async function runCollectionsCron(kind: CollectionsCronKind, now: Date): Promise<CollectionsCronRun> {
  const tenants = await prisma.tenantConfig.findMany({
    where: { collectionsEngineEnabled: true, collectionProvider: { not: null } },
    select: { tenantId: true },
    orderBy: { tenantId: "asc" },
  })
  const perTenant: TenantCollectionsRun[] = []
  for (const { tenantId } of tenants) {
    try {
      const run = await runWithTenant(tenantId, async (): Promise<TenantCollectionsRun> => {
        const ctx = await loadEngineContext(tenantId, now)
        if (!ctx) return { tenantId, outcome: "SKIPPED", reason: "engine switched off during the run" }
        if (kind === "RESULTS") return { tenantId, outcome: "RESULTS", results: await ingestResults(ctx) }
        const mandates = await refreshMandates(ctx)
        const planned = await planTenantInstructions(ctx)
        const submitted = await submitDueInstructions(ctx)
        return { tenantId, outcome: "SUBMIT", mandates, planned, submitted }
      })
      perTenant.push(run)
    } catch (error) {
      perTenant.push({ tenantId, outcome: "ERROR", error: errorSummary(error) })
    }
  }
  return { ok: perTenant.every((t) => t.outcome !== "ERROR"), kind, perTenant }
}
