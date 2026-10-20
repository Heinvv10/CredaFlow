/**
 * Deployment URLs and hosts — env only, no defaults.
 *
 * Hosts are deployment wiring, not lender identity: proxy.ts runs before any
 * DB access and NEXT_PUBLIC_* values are baked into the client bundle at
 * build, so they cannot come from TenantConfig. An unset value throws at the
 * point of use (a link is never built against another deployment's host);
 * importing this module never throws, so a build without the env still works.
 */

export class DeploymentConfigError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "DeploymentConfigError"
  }
}

// `|| undefined` treats an empty string as unset: the Docker build declares
// these ARGs with an empty default, which produces a defined-but-empty var.
function absoluteUrl(raw: string | undefined): string | null {
  const value = (raw || undefined)?.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" && url.protocol !== "http:") return null
  } catch {
    return null
  }
  // Trailing slash stripped so `${BASE}/portal/...` never yields `//portal`
  // (which would break proxy.ts's exact `pathname === "/portal/login"` gate).
  return value.replace(/\/+$/, "")
}

/** Staff app origin (`NEXTAUTH_URL`). Throws when unset or not a URL. */
export function requireAppBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const url = absoluteUrl(env.NEXTAUTH_URL)
  if (!url) throw new DeploymentConfigError("NEXTAUTH_URL is not set to an absolute URL.")
  return url
}

/**
 * Client-portal origin. Prefers the login-URL override NavBar and the
 * homepage CTA already use (`NEXT_PUBLIC_PORTAL_LOGIN_URL`, e.g.
 * ".../portal/login") so the app shares one knob, then
 * `NEXT_PUBLIC_PORTAL_URL`. Both are read as literal `process.env.X` so Next
 * inlines them into client bundles. Throws when neither is set.
 */
export function requirePortalBaseUrl(): string {
  const fromLogin = absoluteUrl(
    (process.env.NEXT_PUBLIC_PORTAL_LOGIN_URL || undefined)?.trim().replace(/\/portal\/login\/?$/, ""),
  )
  const url = fromLogin ?? absoluteUrl(process.env.NEXT_PUBLIC_PORTAL_URL)
  if (!url) {
    throw new DeploymentConfigError("NEXT_PUBLIC_PORTAL_URL (or NEXT_PUBLIC_PORTAL_LOGIN_URL) is not set.")
  }
  return url
}

/**
 * Public website origin (`NEXT_PUBLIC_WEBSITE_URL`), or null when unset. The
 * website's canonical URLs, JSON-LD ids, sitemap and robots use it; unset,
 * they stay relative or are left out rather than naming another site.
 */
export function websiteBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  return absoluteUrl(env.NEXT_PUBLIC_WEBSITE_URL)
}

/** Bare hostname, lower-cased, no port or trailing dot. */
export function normaliseHost(host: string): string {
  return host.split(":")[0].toLowerCase().replace(/\.$/, "")
}

/**
 * `TENANT_HOST_MAP="app.lender.example=lender,portal.lender.example=lender"`.
 * Unset or empty ⇒ no explicit host mapping. A malformed entry throws: a
 * typo here would route a host to the wrong tenant or to none.
 */
export function parseTenantHostMap(raw: string | undefined): Record<string, string> {
  const map: Record<string, string> = {}
  for (const entry of (raw ?? "").split(",").map((e) => e.trim()).filter(Boolean)) {
    const match = /^([a-z0-9.-]+)=([a-z0-9-]+)$/i.exec(entry)
    if (!match) throw new DeploymentConfigError(`TENANT_HOST_MAP entry "${entry}" is not host=slug.`)
    map[normaliseHost(match[1])] = match[2].toLowerCase()
  }
  return map
}

/** The staff workspace host (`STAFF_APP_HOST`), or null when not configured. */
export function staffAppHost(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const host = env.STAFF_APP_HOST?.trim()
  return host ? normaliseHost(host) : null
}

/**
 * The operator console host (`OPERATOR_APP_HOST`), or null when not
 * configured. Operator staff sign in and work only on this host, and nothing
 * else is served on it (lib/proxy/operator-host.ts). Unset: no operator
 * sign-in anywhere.
 */
export function operatorAppHost(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const host = env.OPERATOR_APP_HOST?.trim()
  return host ? normaliseHost(host) : null
}

/**
 * The operator console origin: the deployment's own scheme and port
 * (`NEXTAUTH_URL`) on `OPERATOR_APP_HOST`. Throws when either is unset.
 */
export function requireOperatorBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const host = operatorAppHost(env)
  if (!host) throw new DeploymentConfigError("OPERATOR_APP_HOST is not set.")
  const url = new URL(requireAppBaseUrl(env))
  url.hostname = host
  return url.origin
}

/**
 * The dealer portal host (`DEALER_APP_HOST`), or null when not configured.
 * Dealer users sign in and work only on this host, and nothing else is served
 * on it (lib/proxy/dealer-host.ts). It runs on the staff container and needs a
 * `TENANT_HOST_MAP` entry (the subdomain fallback would read the first label
 * as the lender's slug). Unset: no dealer sign-in anywhere. Throws when it
 * names the staff or operator host: one host serves one audience.
 */
export function dealerAppHost(env: Readonly<Record<string, string | undefined>> = process.env): string | null {
  const raw = env.DEALER_APP_HOST?.trim()
  if (!raw) return null
  const host = normaliseHost(raw)
  if (host === staffAppHost(env) || host === operatorAppHost(env)) {
    throw new DeploymentConfigError("DEALER_APP_HOST must differ from STAFF_APP_HOST and OPERATOR_APP_HOST.")
  }
  return host
}

/**
 * The dealer portal origin: the deployment's own scheme and port
 * (`NEXTAUTH_URL`) on `DEALER_APP_HOST`. Throws when either is unset.
 */
export function requireDealerBaseUrl(env: Readonly<Record<string, string | undefined>> = process.env): string {
  const host = dealerAppHost(env)
  if (!host) throw new DeploymentConfigError("DEALER_APP_HOST is not set.")
  const url = new URL(requireAppBaseUrl(env))
  url.hostname = host
  return url.origin
}
