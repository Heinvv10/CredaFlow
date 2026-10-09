import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { generateDaily, generateMonthly, submissionMode, type GenerateResult } from "./generate"
import type { SubmissionKind } from "./layout"
import type { Day } from "./period"
import { pushConfigured } from "./push"
import { BureauError } from "./validate"

// One run of a bureau cron across every tenant with the feature on. Tenants
// with the flag off are not read at all.

export type TenantRun =
  | ({ tenantId: string } & GenerateResult)
  | { tenantId: string; outcome: "ERROR"; error: string }

export interface BureauCronRun {
  /** false when ANY tenant failed; the route turns that into a non-2xx */
  ok: boolean
  kind: SubmissionKind
  mode: "TEST" | "LIVE"
  day: Day
  perTenant: TenantRun[]
  /** set when the run was refused before any tenant was read */
  error?: string
}

export async function runBureauCron(kind: SubmissionKind, day: Day, now: Date): Promise<BureauCronRun> {
  const mode = submissionMode()
  // LIVE rows record what the bureau was told. With no transport nothing is
  // told, so a LIVE run is a misconfiguration: refuse it loudly, write nothing.
  if (mode === "LIVE" && !pushConfigured()) {
    return { ok: false, kind, mode, day, perTenant: [], error: "LIVE mode is refused while no push transport is configured" }
  }
  const tenants = await prisma.tenantConfig.findMany({
    where: { featureBureauSubmission: true },
    select: { tenantId: true },
    orderBy: { tenantId: "asc" },
  })
  const perTenant: TenantRun[] = []
  for (const { tenantId } of tenants) {
    try {
      const actor = { source: "cron" as const }
      const result = await runWithTenant(tenantId, async () => kind === "MONTHLY"
        ? await generateMonthly(prisma, { tenantId, periodDay: day, mode, now, actor })
        : await generateDaily(prisma, { tenantId, day, mode, now, actor }))
      perTenant.push({ tenantId, ...result })
    } catch (error) {
      // Only this module's own errors are echoed: they name rules and periods.
      // Anything else (a database error can quote row values) is reduced to
      // its class and code.
      const code = typeof (error as { code?: unknown })?.code === "string" ? ` ${(error as { code: string }).code}` : ""
      perTenant.push({
        tenantId,
        outcome: "ERROR",
        error: error instanceof BureauError ? error.message : `${error instanceof Error ? error.name : "Error"}${code}`,
      })
    }
  }
  return { ok: perTenant.every((t) => t.outcome !== "ERROR"), kind, mode, day, perTenant }
}
