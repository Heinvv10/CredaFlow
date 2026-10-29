import { parseCurrency, parseJurisdiction, profileFor, type Currency, type Jurisdiction } from "./profiles"

/**
 * The jurisdiction and currency this deployment runs as. One instance serves
 * one lender (docs/ARCHITECTURE.md), so a process-wide value is enough and it
 * lets the many synchronous formatters and gates read it without a tenant
 * argument. It is loaded from `TenantConfig` by ./load.server.ts (server boot
 * and the root layout) and primed in the browser by components/JurisdictionProvider.
 *
 * Until something sets it the value is ZA / ZAR: an unconfigured process keeps
 * the NCA gates ON, so a failure to load can only make behaviour stricter.
 *
 * The state lives on globalThis because Next bundles the server entry points
 * (instrumentation, route handlers, server components) separately; a plain
 * module variable would be a different copy in each.
 */
interface ActiveState {
  jurisdiction: Jurisdiction
  currency: Currency
}

const KEY = Symbol.for("credaflow.activeJurisdiction")
const DEFAULT: ActiveState = { jurisdiction: "ZA", currency: "ZAR" }

function store(): ActiveState {
  const holder = globalThis as Record<symbol, ActiveState | undefined>
  return holder[KEY] ?? DEFAULT
}

export function setActiveJurisdiction(next: { jurisdiction: Jurisdiction; currency: Currency }): void {
  const state: ActiveState = { jurisdiction: parseJurisdiction(next.jurisdiction), currency: parseCurrency(next.currency) }
  ;(globalThis as Record<symbol, ActiveState>)[KEY] = state
}

export function resetActiveJurisdiction(): void {
  delete (globalThis as Record<symbol, ActiveState | undefined>)[KEY]
}

export function activeJurisdiction(): Jurisdiction {
  return store().jurisdiction
}

export function activeCurrency(): Currency {
  return store().currency
}

/**
 * The one gate for NCA-only steps: the interest-rate cap, Section 129
 * notices, NCR/FSCA returns. Applied at each step's entry point; true for ZA.
 */
export function isNcaJurisdiction(): boolean {
  return profileFor(store().jurisdiction).ncaRegulated
}
