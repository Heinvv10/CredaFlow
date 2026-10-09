/**
 * Bureau data submission — monthly DRY RUN (lib/bureau-submission).
 *
 * READ-ONLY. Maps and validates the book exactly as the monthly generator
 * would, writes nothing, and prints COUNTS ONLY: the population, the
 * account-type split and the held records by reason. Never a name, an ID
 * number or an account number — the output is safe to paste into a ticket.
 *
 * Works while the feature flag is off and before a supplier number exists, so
 * the data clean-up can be sized before anything is configured:
 *
 *   npx tsx scripts/bureau-submission-dry-run.ts --tenant-id <tenant-id> \
 *     [--period YYYY-MM-DD] [--reporting-start YYYY-MM-DD]
 *
 * --period defaults to the last month end; --reporting-start defaults to the
 * tenant's configured date, else the first day of the period's month.
 *
 * Running this against staging or production reads live client data and needs
 * Hein's explicit go.
 */
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { dbDateToDay, isDay, isMonthEnd, monthStartOf, previousMonthEnd } from "@/lib/bureau-submission/period"
import { prepareMonthly } from "@/lib/bureau-submission/prepare"

function option(name: string): string | null {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? null : null
}

function tally(values: string[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)))
}

async function main(): Promise<void> {
  const tenantId = option("--tenant-id")
  if (!tenantId) throw new Error("--tenant-id is required")
  const period = option("--period") ?? previousMonthEnd(new Date())
  if (!isDay(period) || !isMonthEnd(period)) throw new Error("--period must be a month end, YYYY-MM-DD")

  const config = await prisma.tenantConfig.findUnique({
    where: { tenantId },
    select: { featureBureauSubmission: true, bureauSupplierNumber: true, bureauReportingStartDate: true },
  })
  if (!config) throw new Error("No such tenant")
  const reportingStart = option("--reporting-start")
    ?? (config.bureauReportingStartDate ? dbDateToDay(config.bureauReportingStartDate) : monthStartOf(period))
  if (!isDay(reportingStart)) throw new Error("--reporting-start must be YYYY-MM-DD")

  const prepared = await runWithTenant(tenantId, () => prepareMonthly(prisma, {
    tenantId, day: period, reportingStartDay: reportingStart, supplierNumber: "DRYRUN",
  }))
  const sendable = prepared.filter((p) => p.held.length === 0)
  const held = prepared.filter((p) => p.held.length > 0)

  process.stdout.write(`${JSON.stringify({
    dryRun: true,
    period,
    reportingStart,
    featureFlagOn: config.featureBureauSubmission,
    supplierNumberSet: Boolean(config.bureauSupplierNumber?.trim()),
    population: prepared.length,
    byAccountType: tally(prepared.map((p) => p.mapped.fields.accountType)),
    wouldSend: sendable.length,
    wouldSendByStatus: tally(sendable.map((p) => p.mapped.statusCode ?? "none")),
    held: held.length,
    heldByReason: tally(held.flatMap((p) => p.held)),
  }, null, 2)}\n`)
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exit(1)
  })
