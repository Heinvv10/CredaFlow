import { logger } from "@/lib/observability/logger"
import { prisma } from "@/lib/prisma"
import { activeCurrency, activeJurisdiction, isJurisdictionLoaded, setActiveJurisdiction } from "./active"
import { parseCurrency, parseJurisdiction, type Currency, type Jurisdiction } from "./profiles"

interface InstanceRow {
  jurisdiction: string
  currency: string
}

type InstanceDb = {
  instanceJurisdiction: {
    findUnique: (args: { where: { id: 1 } }) => Promise<InstanceRow | null>
  }
}

export interface ActiveJurisdictionState {
  jurisdiction: Jurisdiction
  currency: Currency
}

/**
 * The database's instance jurisdiction no longer matches the one this process
 * is serving under. The process refuses to serve (a stale value would print the
 * wrong currency and let the wrong gates through) until it matches again or is
 * restarted.
 */
export class JurisdictionChangedError extends Error {
  constructor(readonly inUse: string, readonly inDatabase: string) {
    super(
      `The instance jurisdiction in the database (${inDatabase}) differs from the one this process is serving under (${inUse}). `
      + "Restart the process; it refuses to serve meanwhile.",
    )
    this.name = "JurisdictionChangedError"
  }
}

const current = (): ActiveJurisdictionState => ({ jurisdiction: activeJurisdiction(), currency: activeCurrency() })
const key = (s: ActiveJurisdictionState) => `${s.jurisdiction}/${s.currency}`

const logError = (message: string, error?: unknown) =>
  logger.error(`[jurisdiction] ${message}`, error === undefined ? undefined : { error: error instanceof Error ? error.message : String(error) })

/**
 * Reads the InstanceJurisdiction row (the single source of truth: every lender's
 * TenantConfig must equal it, enforced by triggers). First read adopts it; a
 * later read that differs from what the process is already using throws
 * JurisdictionChangedError. `settled` is false when there is no row (the
 * database is not migrated), leaving the fail-closed default: ZA, NCA gates on.
 */
async function readJurisdiction(db: InstanceDb): Promise<{ state: ActiveJurisdictionState; settled: boolean }> {
  const row = await db.instanceJurisdiction.findUnique({ where: { id: 1 } })
  if (!row) return { state: current(), settled: false }
  const stored: ActiveJurisdictionState = { jurisdiction: parseJurisdiction(row.jurisdiction), currency: parseCurrency(row.currency) }
  if (isJurisdictionLoaded() && key(stored) !== key(current())) throw new JurisdictionChangedError(key(current()), key(stored))
  setActiveJurisdiction(stored)
  return { state: current(), settled: true }
}

/** One read. Throws JurisdictionChangedError; any other failure is logged and leaves the current value. */
export async function loadActiveJurisdiction(db: InstanceDb = prisma as unknown as InstanceDb): Promise<ActiveJurisdictionState> {
  try {
    return (await readJurisdiction(db)).state
  } catch (error) {
    if (error instanceof JurisdictionChangedError) throw error
    logError("could not load the instance jurisdiction; keeping the current value", error)
    return current()
  }
}

const RETRY_COOLDOWN_MS = 5_000
/** A loaded process re-reads the row at most this often. */
export const RELOAD_TTL_MS = 60_000
const BOOT_DELAYS_MS = [0, 500, 1_000, 2_000, 4_000, 8_000]
export const BOOT_TIMEOUT_MS = 20_000

type Outcome = "loaded" | "empty" | "failed"

interface Memo {
  inflight: Promise<ActiveJurisdictionState> | null
  lastAttemptAt: number
  changed: JurisdictionChangedError | null
}
const MEMO_KEY = Symbol.for("credaflow.jurisdictionLoad")
function memo(): Memo {
  const holder = globalThis as Record<symbol, Memo | undefined>
  return (holder[MEMO_KEY] ??= { inflight: null, lastAttemptAt: 0, changed: null })
}

/** Test seam: forget the load memo. */
export function resetEnsuredJurisdiction(): void {
  delete (globalThis as Record<symbol, Memo | undefined>)[MEMO_KEY]
}

async function attempt(db: InstanceDb): Promise<{ state: ActiveJurisdictionState; outcome: Outcome }> {
  const m = memo()
  m.lastAttemptAt = Date.now()
  try {
    const { state, settled } = await readJurisdiction(db)
    m.changed = null
    return { state, outcome: settled ? "loaded" : "empty" }
  } catch (error) {
    if (error instanceof JurisdictionChangedError) {
      m.changed = error
      logError(error.message)
      throw error
    }
    logError("could not read the instance jurisdiction", error)
    return { state: current(), outcome: "failed" }
  }
}

/**
 * The value every server entry point awaits (tenant resolution, the root
 * layout, the cron runner). Instant while a loaded value is younger than
 * RELOAD_TTL_MS; then it re-reads the row. If the database now says something
 * else, it rejects with JurisdictionChangedError (the process does not serve),
 * re-checking every few seconds so it recovers if the value comes back. A
 * re-read that merely FAILS keeps serving the loaded value. Before anything is
 * loaded, one read at a time, and after a failed or empty read none for a few
 * seconds, so a database outage does not turn into a query per request.
 */
export function ensureActiveJurisdiction(db: InstanceDb = prisma as unknown as InstanceDb): Promise<ActiveJurisdictionState> {
  const m = memo()
  if (m.inflight) return m.inflight
  const age = Date.now() - m.lastAttemptAt
  if (m.changed) {
    if (age < RETRY_COOLDOWN_MS) return Promise.reject(m.changed)
  } else if (isJurisdictionLoaded()) {
    if (age < RELOAD_TTL_MS) return Promise.resolve(current())
  } else if (age < RETRY_COOLDOWN_MS) {
    return Promise.resolve(current())
  }
  m.inflight = attempt(db).then((r) => r.state).finally(() => { m.inflight = null })
  return m.inflight
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * Boot: read until the instance row is known. A read that FAILS is retried with
 * backoff; a database with no instance row (not migrated) is not waited for
 * (it boots as ZA, fail-closed, logged once, and the next request retries).
 */
async function loadWithBackoff(db: InstanceDb, sleep: (ms: number) => Promise<void>): Promise<ActiveJurisdictionState> {
  for (const [i, delay] of BOOT_DELAYS_MS.entries()) {
    if (delay > 0) await sleep(delay)
    const { state, outcome } = await attempt(db)
    if (outcome === "loaded") return state
    if (outcome === "empty") {
      logError("no instance jurisdiction row (is the database migrated?); booting as ZA with the NCA gates on")
      return state
    }
    logError(`attempt ${i + 1}/${BOOT_DELAYS_MS.length}: the database could not be read`)
  }
  logError("giving up at boot; running as ZA with the NCA gates on until a request retries")
  return current()
}

/**
 * instrumentation.ts: load the jurisdiction before serving. Waits at most
 * `timeoutMs` (a hung database must not block boot for ever), then lets boot
 * continue while the retries run on.
 */
export async function bootActiveJurisdiction(opts: {
  db?: InstanceDb
  timeoutMs?: number
  sleep?: (ms: number) => Promise<void>
} = {}): Promise<ActiveJurisdictionState> {
  const { db = prisma as unknown as InstanceDb, timeoutMs = BOOT_TIMEOUT_MS, sleep = wait } = opts
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
    loading.catch(() => undefined)
  }
}
