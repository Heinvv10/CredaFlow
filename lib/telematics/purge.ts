/**
 * Position retention (cron asset-finance-telematics-purge, nightly; docs/asset-
 * finance/SLICE5.md part B, POPIA). Per tenant, with that tenant's
 * TenantConfig.telematicsPositionRetentionDays: the TelematicsPosition rows
 * older than it, then every event older than it that nothing refers to any
 * more (no position, reading, held reading or alert). A METER or ALERT event
 * a reading, held reading or work item refers to stays with it, and so does
 * the access log (it holds no coordinate). Batches of 5 000 like lib/lender-api/retention.ts. The
 * cutoff is the database's clock, the one guardTelematicsEvent checks. One
 * audit row per tenant that lost rows, counts only.
 */
import { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { runWithTenant } from "@/lib/tenant-scope"
import { AuditAction, logAuditStrict } from "@/lib/audit"

const BATCH = 5_000
const MAX_BATCHES = 200

export interface TelematicsPurgeRun {
  ok: boolean
  tenants: number
  positions: number
  events: number
  failed: number
}

async function inBatches(run: () => Promise<number>): Promise<number> {
  let total = 0
  for (let i = 0; i < MAX_BATCHES; i++) {
    const n = await run()
    total += n
    if (n < BATCH) break
  }
  return total
}

async function purgeTenant(tenantId: string, days: number): Promise<{ positions: number; events: number }> {
  const cutoff = Prisma.sql`(now() AT TIME ZONE 'UTC') - make_interval(days => ${days}::int)`
  const positions = await inBatches(() => prisma.$executeRaw(Prisma.sql`
    DELETE FROM "TelematicsPosition" WHERE "id" IN (
      SELECT "id" FROM "TelematicsPosition" WHERE "tenantId" = ${tenantId} AND "occurredAt" < ${cutoff} LIMIT ${BATCH})`))
  const events = await inBatches(() => prisma.$executeRaw(Prisma.sql`
    DELETE FROM "TelematicsEvent" WHERE "id" IN (
      SELECT e."id" FROM "TelematicsEvent" e
      WHERE e."tenantId" = ${tenantId} AND e."occurredAt" < ${cutoff}
        AND NOT EXISTS (SELECT 1 FROM "TelematicsPosition" p WHERE p."eventId" = e."id")
        AND NOT EXISTS (SELECT 1 FROM "AssetMeterReading" m WHERE m."telematicsEventId" = e."id")
        AND NOT EXISTS (SELECT 1 FROM "TelematicsHeldReading" h WHERE h."eventId" = e."id")
        AND NOT EXISTS (SELECT 1 FROM "TelematicsAlert" a WHERE a."eventId" = e."id")
      LIMIT ${BATCH})`))
  if (positions + events > 0) {
    await logAuditStrict({
      tenantId, action: AuditAction.TELEMATICS_POSITIONS_PURGED, entity: "TelematicsPosition",
      newValue: { retentionDays: days, positions, events, actor: { type: "system", source: "telematics-purge" } },
    })
  }
  return { positions, events }
}

export async function purgeTelematicsPositions(): Promise<TelematicsPurgeRun> {
  const run: TelematicsPurgeRun = { ok: true, tenants: 0, positions: 0, events: 0, failed: 0 }
  // Every tenant with a device, whatever its feature flag today: retention outlives a switched-off module.
  const tenants = await prisma.tenantConfig.findMany({
    where: { tenant: { trackerDevices: { some: {} } } }, orderBy: { tenantId: "asc" }, select: { tenantId: true, telematicsPositionRetentionDays: true },
  })
  for (const { tenantId, telematicsPositionRetentionDays } of tenants) {
    run.tenants++
    try {
      const purged = await runWithTenant(tenantId, () => purgeTenant(tenantId, telematicsPositionRetentionDays))
      run.positions += purged.positions
      run.events += purged.events
    } catch (error) {
      run.failed++
      console.error("[telematics-purge] tenant failed", { tenantId, error: error instanceof Error ? error.message : "unknown" })
    }
  }
  run.ok = run.failed === 0
  return run
}
