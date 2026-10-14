/**
 * One run of a collections-engine cron across every tenant whose engine is on.
 * Tenants with collectionsEngineEnabled off are not read at all: for them the
 * run is a no-op, byte for byte.
 *
 *   SUBMIT  — close mandates of closed loans, refresh mandates with the
 *             provider, reconcile lost submissions, plan instructions from
 *             the schedules, submit what is due, read load reports, and
 *             withdraw suspended / cancelled mandates at the provider.
 *   RESULTS — fetch provider outcomes and act on them, re-apply the stop
 *             rules, withdraw suspended mandates at the provider.
 *
 * `ok` is false when any tenant failed outright OR any step recorded an error,
 * so the scheduler sees a non-2xx for a partial failure too.
 */
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { errorSummary, loadEngineContext } from "./context"
import { refreshMandates, type RefreshSummary } from "./mandate-lifecycle"
import { cancelAtProvider, closeMandatesOfClosedLoans, emptySweep, type SweepSummary } from "./mandate-sweeps"
import { emptyReconcile, pollLoadReports, reconcileStuckInstructions, type ReconcileSummary } from "./reconcile"
import { planTenantInstructions, type PlanSummary } from "./instructions"
import { submitDueInstructions, type SubmitSummary } from "./submit"
import { ingestResults, type IngestSummary } from "./results"

export type CollectionsCronKind = "SUBMIT" | "RESULTS"

export type TenantCollectionsRun =
  | { tenantId: string; outcome: "SUBMIT"; sweeps: SweepSummary; mandates: RefreshSummary; reconcile: ReconcileSummary; planned: PlanSummary; submitted: SubmitSummary }
  | { tenantId: string; outcome: "RESULTS"; results: IngestSummary; sweeps: SweepSummary }
  | { tenantId: string; outcome: "SKIPPED"; reason: string }
  | { tenantId: string; outcome: "ERROR"; error: string }

export interface CollectionsCronRun {
  /** false when any tenant errored or any step recorded an error; the route turns that into a non-2xx */
  ok: boolean
  kind: CollectionsCronKind
  perTenant: TenantCollectionsRun[]
}

export function tenantRunErrors(run: TenantCollectionsRun): string[] {
  switch (run.outcome) {
    case "ERROR":
      return [run.error]
    case "SKIPPED":
      return []
    case "RESULTS":
      return [...run.results.errors, ...run.sweeps.errors]
    case "SUBMIT":
      return [...run.sweeps.errors, ...run.mandates.errors, ...run.reconcile.errors, ...run.planned.errors, ...run.submitted.failedBatches, ...run.submitted.errors]
  }
}

/** One tenant's run (also the integration suites' entry point, unaffected by other tenants). */
export async function runTenant(kind: CollectionsCronKind, tenantId: string, now: Date): Promise<TenantCollectionsRun> {
  const ctx = await loadEngineContext(tenantId, now)
  if (!ctx) return { tenantId, outcome: "SKIPPED", reason: "engine switched off during the run" }
  const sweeps = emptySweep()
  if (kind === "RESULTS") {
    const results = await ingestResults(ctx)
    await cancelAtProvider(ctx, sweeps)
    return { tenantId, outcome: "RESULTS", results, sweeps }
  }
  await closeMandatesOfClosedLoans(ctx, sweeps)
  const mandates = await refreshMandates(ctx)
  const reconcile = emptyReconcile()
  await reconcileStuckInstructions(ctx, reconcile)
  const planned = await planTenantInstructions(ctx)
  const submitted = await submitDueInstructions(ctx)
  // After submitting, so a rail that loads at once is read in the same run.
  await pollLoadReports(ctx, reconcile)
  await cancelAtProvider(ctx, sweeps)
  return { tenantId, outcome: "SUBMIT", sweeps, mandates, reconcile, planned, submitted }
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
      perTenant.push(await runWithTenant(tenantId, () => runTenant(kind, tenantId, now)))
    } catch (error) {
      perTenant.push({ tenantId, outcome: "ERROR", error: errorSummary(error) })
    }
  }
  return { ok: perTenant.every((t) => tenantRunErrors(t).length === 0), kind, perTenant }
}
