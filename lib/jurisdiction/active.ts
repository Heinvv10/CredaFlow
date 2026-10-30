import { parseCurrency, parseJurisdiction, profileFor, type Currency, type Jurisdiction } from "./profiles"

/**
 * The jurisdiction and currency this deployment runs as. One instance serves
 * one lender (docs/ARCHITECTURE.md, "Jurisdiction"), so a process-wide value is
 * the design, and boot enforces it: ./load.server.ts refuses to start when the
 * instance's active tenants disagree. Synchronous formatters and gates read it
 * without a tenant argument. It is loaded from `TenantConfig` (server boot,
 * tenant resolution, the root layout) and primed in the browser by
 * components/JurisdictionProvider.
 *
 * Until something sets it the value is ZA / ZAR with `loaded` false: an
 * unconfigured process keeps the NCA gates ON, so a failure to load can only
 * make behaviour stricter.
 *
 * The state lives on globalThis because Next bundles the server entry points
 * (instrumentation, route handlers, server components) separately; a plain
 * module variable would be a different copy in each.
 */
interface ActiveState {
  jurisdiction: Jurisdiction
  currency: Currency
  loaded: boolean
}

const KEY = Symbol.for("credaflow.activeJurisdiction")
const DEFAULT: ActiveState = { jurisdiction: "ZA", currency: "ZAR", loaded: false }

function store(): ActiveState {
  const holder = globalThis as Record<symbol, ActiveState | undefined>
  return holder[KEY] ?? DEFAULT
}

/**
 * Makes `next` the active value. A South African lender is billed in rand only
 * (the NCA documents print the currency); an LS lender may use loti or rand
 * (the rand is legal tender in Lesotho). Anything else throws.
 */
export function setActiveJurisdiction(next: { jurisdiction: Jurisdiction; currency: Currency }): void {
  const jurisdiction = parseJurisdiction(next.jurisdiction)
  const currency = parseCurrency(next.currency)
  if (jurisdiction === "ZA" && currency !== "ZAR") {
    throw new Error(`A ZA lender is billed in ZAR only, not ${currency}`)
  }
  ;(globalThis as Record<symbol, ActiveState>)[KEY] = { jurisdiction, currency, loaded: true }
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

/** True once a real value was set (as opposed to the fail-closed default). */
export function isJurisdictionLoaded(): boolean {
  return store().loaded
}

/**
 * The one gate for NCA-only steps: the interest-rate cap, Section 129
 * notices, NCR/FSCA returns. Applied at each step's entry point; true for ZA.
 */
export function isNcaJurisdiction(): boolean {
  return profileFor(store().jurisdiction).ncaRegulated
}
