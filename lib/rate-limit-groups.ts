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
  // The paid bureau pulls behind a portal application: a client's submission counters must never be evicted or decided
  // in memory (a lifted counter is free credit checks), so they are authentication-grade although keyed by a session.
  "portal:apply:",
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

/**
 * Ordinary limits whose key the CALLER chooses (a token, a phone number): groups of their own, so a flood of made-up
 * keys fills and is capped in its own group (lib/rate-limit-cleanup.ts) and cannot evict the counters of the others.
 * Every other ordinary key is grouped by its first segment (`website:`, `portal:`, `statement-ai-ask:`, ...), which the
 * code, not the caller, chooses.
 */
export const CALLER_KEYED_GROUPS: readonly string[] = ["selfie-link:capture:tok:", "website:chat:start:phone:"].sort((a, b) => b.length - a.length)

export function classify(namespace: string, key: string): Classified {
  if (namespace !== "") return { group: namespace, failClosed: FAIL_CLOSED_NAMESPACES.has(namespace), podLocal: false }
  const prefix = FAIL_CLOSED_KEY_PREFIXES.find((p) => key.startsWith(p)) // longest first
  if (prefix !== undefined) return { group: prefix, failClosed: true, podLocal: false }
  const own = CALLER_KEYED_GROUPS.find((p) => key.startsWith(p))
  const colon = key.indexOf(":")
  return { group: own ?? (colon >= 0 ? key.slice(0, colon + 1) : ""), failClosed: false, podLocal: POD_LOCAL_KEYS.has(key) }
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
