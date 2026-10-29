import { prisma } from "@/lib/prisma"
import { activeCurrency, activeJurisdiction, isJurisdictionLoaded, setActiveJurisdiction } from "./active"
import { parseCurrency, parseJurisdiction, type Currency, type Jurisdiction } from "./profiles"

interface ConfigRow {
  jurisdiction: string
  currency: string
  tenant: { slug: string }
}

type ConfigDb = {
  tenantConfig: {
    findMany: (args: {
      where: { tenant: { status: "ACTIVE" } }
      select: { jurisdiction: true; currency: true; tenant: { select: { slug: true } } }
    }) => Promise<ConfigRow[]>
  }
}

export interface ActiveJurisdictionState {
  jurisdiction: Jurisdiction
  currency: Currency
}

/** The instance's ACTIVE tenants disagree about jurisdiction or currency. Fatal at boot. */
export class JurisdictionConflictError extends Error {
  constructor(readonly tenants: Record<string, string>) {
    super(
      "One instance serves one jurisdiction, but its active tenants differ: "
      + Object.entries(tenants).map(([slug, key]) => `${slug}=${key}`).join(", ")
      + ". Give each jurisdiction its own instance and database.",
    )
    this.name = "JurisdictionConflictError"
  }
}

const current = (): ActiveJurisdictionState => ({ jurisdiction: activeJurisdiction(), currency: activeCurrency() })

// TODO(#252): switch these to the repo logger when lib/observability/logger.ts lands on main.
const logError = (message: string, error?: unknown) => console.error(`[jurisdiction] ${message}`, error ?? "")

/**
 * Reads the instance's lender from `TenantConfig` and makes it the active
 * jurisdiction (./active.ts). Every ACTIVE tenant is read: they must all agree
 * (JurisdictionConflictError otherwise, which the caller lets propagate: the
 * process must not run on a guess). When NEXT_PUBLIC_TENANT_SLUG is set, that
 * tenant must be ACTIVE. Returns settled=false, leaving the fail-closed default
 * (ZA, NCA gates on), when there is nothing to adopt yet.
 */
async function readJurisdiction(db: ConfigDb): Promise<{ state: ActiveJurisdictionState; settled: boolean }> {
  const rows = await db.tenantConfig.findMany({
    where: { tenant: { status: "ACTIVE" } },
    select: { jurisdiction: true, currency: true, tenant: { select: { slug: true } } },
  })
  if (rows.length === 0) return { state: current(), settled: false }
  const keys = Object.fromEntries(rows.map((row) => [row.tenant.slug, `${row.jurisdiction}/${row.currency}`]))
  if (new Set(Object.values(keys)).size > 1) throw new JurisdictionConflictError(keys)
  const slug = process.env.NEXT_PUBLIC_TENANT_SLUG?.trim()
  if (slug && !(slug in keys)) {
    logError(`NEXT_PUBLIC_TENANT_SLUG "${slug}" is not an ACTIVE tenant; keeping ZA`)
    return { state: current(), settled: false }
  }
  setActiveJurisdiction({ jurisdiction: parseJurisdiction(rows[0].jurisdiction), currency: parseCurrency(rows[0].currency) })
  return { state: current(), settled: true }
}

/** One read. Throws JurisdictionConflictError; any other failure is logged and leaves the current value. */
export async function loadActiveJurisdiction(db: ConfigDb = prisma as unknown as ConfigDb): Promise<ActiveJurisdictionState> {
  try {
    return (await readJurisdiction(db)).state
  } catch (error) {
    if (error instanceof JurisdictionConflictError) throw error
    logError("could not load the lender's jurisdiction; keeping the current value", error)
    return current()
  }
}

const RETRY_COOLDOWN_MS = 5_000
const BOOT_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000, 8_000]
export const BOOT_TIMEOUT_MS = 20_000

interface Memo {
  inflight: Promise<ActiveJurisdictionState> | null
  lastFailureAt: number
  fatal: JurisdictionConflictError | null
}
const MEMO_KEY = Symbol.for("credaflow.jurisdictionLoad")
function memo(): Memo {
  const holder = globalThis as Record<symbol, Memo | undefined>
  return (holder[MEMO_KEY] ??= { inflight: null, lastFailureAt: 0, fatal: null })
}

/** Test seam: forget the load memo. */
export function resetEnsuredJurisdiction(): void {
  delete (globalThis as Record<symbol, Memo | undefined>)[MEMO_KEY]
}

async function attempt(db: ConfigDb): Promise<ActiveJurisdictionState> {
  const m = memo()
  try {
    const { state, settled } = await readJurisdiction(db)
    if (!settled) m.lastFailureAt = Date.now()
    return state
  } catch (error) {
    if (error instanceof JurisdictionConflictError) {
      m.fatal = error
      throw error
    }
    logError("could not load the lender's jurisdiction", error)
    m.lastFailureAt = Date.now()
    return current()
  }
}

/**
 * The value every server entry point awaits (tenant resolution, the root
 * layout, the cron runner). Instant once loaded. Otherwise one read at a time,
 * and after a failed or empty read no new one for a few seconds, so a database
 * outage does not turn into a query per request. Rejects with
 * JurisdictionConflictError, permanently, if the tenants disagree.
 */
export function ensureActiveJurisdiction(db: ConfigDb = prisma as unknown as ConfigDb): Promise<ActiveJurisdictionState> {
  const m = memo()
  if (m.fatal) return Promise.reject(m.fatal)
  if (isJurisdictionLoaded()) return Promise.resolve(current())
  if (m.inflight) return m.inflight
  if (Date.now() - m.lastFailureAt < RETRY_COOLDOWN_MS) return Promise.resolve(current())
  m.inflight = attempt(db).finally(() => { m.inflight = null })
  return m.inflight
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Boot: read with backoff until the lender is known, logging each miss. The
 * caller bounds how long it waits (`bootActiveJurisdiction`); the retries
 * continue behind it. Conflicting tenants reject at once.
 */
async function loadWithBackoff(db: ConfigDb, sleep: (ms: number) => Promise<void>): Promise<ActiveJurisdictionState> {
  for (const [i, delay] of BOOT_DELAYS_MS.entries()) {
    if (delay > 0) await sleep(delay)
    const state = await attemptBoot(db)
    if (isJurisdictionLoaded()) return state
    logError(`attempt ${i + 1}/${BOOT_DELAYS_MS.length}: no lender configuration yet`)
  }
  logError("giving up at boot; running as ZA with the NCA gates on until a request retries")
  return current()
}

async function attemptBoot(db: ConfigDb): Promise<ActiveJurisdictionState> {
  const m = memo()
  m.lastFailureAt = 0
  m.inflight ??= attempt(db).finally(() => { m.inflight = null })
  return m.inflight
}

/**
 * instrumentation.ts: load the jurisdiction before serving. Waits at most
 * `timeoutMs` (a hung database must not block boot for ever), then lets boot
 * continue while the retries run on. Throws JurisdictionConflictError, which
 * stops the process: the instance's tenants must agree.
 */
export async function bootActiveJurisdiction(opts: {
  db?: ConfigDb
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
} = {}): Promise<ActiveJurisdictionState> {
  const { db = prisma as unknown as ConfigDb, timeoutMs = BOOT_TIMEOUT_MS, sleep = wait } = opts
  const loading = loadWithBackoff(db, sleep)
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<ActiveJurisdictionState>((resolve) => {
    timer = setTimeout(() => {
      logError(`not loaded after ${timeoutMs} ms; booting as ZA with the NCA gates on, retrying in the background`)
      resolve(current())
    }, timeoutMs)
  })
  try {
    return await Promise.race([loading, timeout])
  } finally {
    clearTimeout(timer)
    // A conflict found after the timeout has nobody to throw to: it is memoised, so every request rejects.
    loading.catch(() => undefined)
  }
}
