import { prisma } from "@/lib/prisma"
import { activeCurrency, activeJurisdiction, setActiveJurisdiction } from "./active"
import { parseCurrency, parseJurisdiction, type Currency, type Jurisdiction } from "./profiles"

type ConfigDb = {
  tenantConfig: {
    findMany: (args: {
      where: { tenant: { slug: string } | { status: "ACTIVE" } }
      select: { jurisdiction: true; currency: true }
      take: number
    }) => Promise<Array<{ jurisdiction: string; currency: string }>>
  }
}

export interface ActiveJurisdictionState {
  jurisdiction: Jurisdiction
  currency: Currency
}

/**
 * Reads the deployment's lender from `TenantConfig` and makes it the active
 * jurisdiction (./active.ts). The lender is the tenant named by
 * NEXT_PUBLIC_TENANT_SLUG, else the only ACTIVE tenant (the same rule as
 * lib/tenant.ts). With several active tenants and no slug there is no single
 * answer, so the default (ZA, NCA gates on) stays: stricter, never looser.
 * A failed read is logged and leaves the current value; it never throws, so a
 * database blip cannot take down the root layout.
 */
export async function loadActiveJurisdiction(db: ConfigDb = prisma as unknown as ConfigDb): Promise<ActiveJurisdictionState> {
  return (await readJurisdiction(db)).state
}

async function readJurisdiction(db: ConfigDb): Promise<{ state: ActiveJurisdictionState; settled: boolean }> {
  let settled = false
  try {
    const slug = process.env.NEXT_PUBLIC_TENANT_SLUG?.trim()
    const rows = await db.tenantConfig.findMany({
      where: { tenant: slug ? { slug } : { status: "ACTIVE" } },
      select: { jurisdiction: true, currency: true },
      take: 2,
    })
    if (rows.length === 1) {
      setActiveJurisdiction({ jurisdiction: parseJurisdiction(rows[0].jurisdiction), currency: parseCurrency(rows[0].currency) })
      settled = true
    } else if (rows.length > 1) {
      console.warn("[jurisdiction] several active tenants and no NEXT_PUBLIC_TENANT_SLUG; keeping ZA")
      settled = true
    }
  } catch (error) {
    console.error("[jurisdiction] could not load the lender's jurisdiction; keeping the current value:", error)
  }
  return { state: { jurisdiction: activeJurisdiction(), currency: activeCurrency() }, settled }
}

let loaded: Promise<ActiveJurisdictionState> | null = null

/**
 * loadActiveJurisdiction once per process (the jurisdiction is deployment
 * configuration; changing it needs a restart), so the root layout adds no
 * query after the first. A read that failed or found no tenant yet is not
 * remembered: the next call tries again.
 */
export function ensureActiveJurisdiction(): Promise<ActiveJurisdictionState> {
  if (!loaded) {
    loaded = readJurisdiction(prisma as unknown as ConfigDb).then(({ state, settled }) => {
      if (!settled) loaded = null
      return state
    })
  }
  return loaded
}

/** Test seam: forget the once-per-process memo. */
export function resetEnsuredJurisdiction(): void {
  loaded = null
}
