/**
 * How the limiter groups its keys: for the breaker, for the row groups in the shared store, and for what the
 * cleanup may evict. Pure data, so the cleanup job can read it without loading the limiter.
 */

/**
 * Limits that guard authentication or a one-time code. When the shared store cannot answer they FAIL CLOSED: the
 * attempt is refused, because the in-memory limiter would start every key at zero on every pod and hand an attacker
 * a fresh budget exactly when the database is struggling. These paths need the database to authenticate anyway.
 * Matched on the key's longest prefix for checkRateLimit (each prefix is its own group), and on the limiter's namespace for
 * createRateLimiter.
 */
export const FAIL_CLOSED_KEY_PREFIXES: readonly string[] = [
  // Address keys (bounded by the address buckets) and keys the caller chooses (an email typed into a form) are separate
  // groups, so neither can crowd the other out of the store or seal the other.
  "login:ip:", "login:email:", "login:combined:", "totp-current-code:", "sso:code:", "sso:start:", "sso:return:",
  "forgot:staff:", "forgot:ip:", "forgot:acct:", "reset-otp:acct:", "reset-otp:", "register:ip:", "register:identity:",
  "portal-password-ip:", "portal-password-acct:", "signing-otp:verify:ip:", "signing-otp:request:ip:",
  // What a sealed group lets an address spend on creating a new key (lib/rate-limit-store.ts).
  "sealed-new:",
].sort((a, b) => b.length - a.length)
export const FAIL_CLOSED_NAMESPACES: ReadonlySet<string> = new Set(["oauth:client", "oauth:failed:address", "lender-api:failed-auth:address"])
/** Seconds a refused-because-the-store-is-down caller is told to wait. */
export const FAIL_CLOSED_RETRY_SECONDS = 30

/**
 * Site-wide counters with a single key. In the shared store every caller would queue on one row lock, so they stay
 * per pod (a limit of L across N pods is at most N x L site-wide): the per-address and per-identity limits beside
 * them are the ones that hold across pods.
 */
export const POD_LOCAL_KEYS: ReadonlySet<string> = new Set(["website:chat:start:all"])

export interface Classified {
  /** Names the breaker and the row group in the shared store. */
  group: string
  failClosed: boolean
  podLocal: boolean
}

export function classify(namespace: string, key: string): Classified {
  if (namespace !== "") return { group: namespace, failClosed: FAIL_CLOSED_NAMESPACES.has(namespace), podLocal: false }
  const prefix = FAIL_CLOSED_KEY_PREFIXES.find((p) => key.startsWith(p)) // longest first
  return { group: prefix ?? "", failClosed: prefix !== undefined, podLocal: POD_LOCAL_KEYS.has(key) }
}


/** Whether a stored group is an authentication group: its rows are lockouts and are never evicted by the row cap. */
export function isAuthGroup(group: string): boolean {
  return FAIL_CLOSED_NAMESPACES.has(group) || FAIL_CLOSED_KEY_PREFIXES.includes(group)
}

/**
 * The authentication groups whose keys the CALLER chooses (an email typed into a form): the only ones that can be sealed
 * when they grow past the hard row ceiling (lib/rate-limit-cleanup.ts). Address-gate groups (login:ip:, forgot:ip:, ...)
 * are never sealed: they are the first line of defence and are bounded by the address buckets (an IPv6 /64), so a flood
 * of made-up emails must never stop them from creating rows.
 */
export const SEALABLE_GROUPS: readonly string[] = ["login:email:", "login:combined:", "forgot:acct:", "reset-otp:acct:", "register:identity:"]
