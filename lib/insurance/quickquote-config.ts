/**
 * FSP Solutions QuickQuote embed — configuration and its guard.
 *
 * QuickQuote (FSP Solutions, FSP licence #7889) quotes short-term personal
 * lines. It is NOT a REST API: the script runs in the visitor's browser and
 * sends their name, SA ID number, contact details, vehicle and address
 * straight to fspsolutions.com over JSONP. Nothing reaches our database — no
 * Lead, no audit row, no processing record — so the widget is a lead channel
 * we cannot observe. The website enquiry form beside it is what keeps the CRM
 * fed; do not remove it on the assumption the widget replaces it.
 *
 * Two properties of FSP's script shape this module:
 *
 * 1. `leadEmail` defaults to "itteam@fspsolutions.com" INSIDE their script. A
 *    missing or blank `elead` does not fail loudly — it silently delivers
 *    the broker's leads to FSP's own IT mailbox. So the config resolves to null
 *    unless every value is present: a partially configured embed must never
 *    render at all. Verified against the live script (fspqq.js.ashx).
 *
 * 2. The script bundles jQuery 1.9.1 (CVE-2020-11022/11023, CVE-2019-11358)
 *    and executes FSP-authored JSONP responses in whichever origin loads it.
 *    It is therefore confined to its own host and reached by iframe, so it
 *    never runs beside a session cookie or inside the marketing origin.
 *    Do NOT import this into app/(website) or app/(portal) to load the script
 *    directly — only app/(quote) may render the widget itself.
 *
 *    That confinement is ENFORCED, not merely documented: FSP_QUICKQUOTE_HOSTS is
 *    an allow-list, `proxy.ts` 404s /quote on any other host, and the page
 *    re-checks its own Host header. An earlier revision stated the invariant
 *    in comments only, and /quote served FSP's script on app.* and portal.*
 *    — the session-bearing origins — which is precisely the outcome the
 *    iframe design exists to prevent.
 *
 * ⚠️ THIS MODULE MUST STAY IMPORT-FREE. `next.config.ts` imports it by
 * relative path to build the `frame-ancestors` header, and the config is
 * loaded before the tsconfig path aliases exist. Adding any import here —
 * `server-only`, `@/lib/prisma`, anything via the `@/` alias — breaks config
 * load, which takes out `next build`, `next start` and `next lint` together,
 * with an error that points at next.config.ts rather than at this edit.
 *
 * A note on what is NOT a secret: `ebc` and `elead` are consumed by FSP's
 * browser-side script, so they are serialised into the page and readable by
 * anyone who loads it. That is inherent to the vendor, not a defect here.
 * They are broker identifiers, not credentials — never treat them as
 * rotatable secrets or assume they are hidden.
 */

type Env = Record<string, string | undefined>

/**
 * Loopback hosts, permitted in development so the surface is testable. Only
 * ever added to a list the operator has already configured: an unset list
 * keeps the quote host off, in development too.
 */
const QUICKQUOTE_DEV_HOSTS = ["localhost", "127.0.0.1"] as const

/** A bare DNS hostname: no scheme, port, path, wildcard or whitespace. */
const HOSTNAME_PATTERN = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/

function listFrom(env: Env, key: string): string[] {
  return (env[key] ?? "")
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter((entry) => entry !== "")
}

/**
 * Whether the loopback relaxations apply.
 *
 * Asserts development POSITIVELY rather than "not production", so any
 * unexpected or unset NODE_ENV falls back to the strict list.
 */
function isDevelopment(env: Env): boolean {
  return env.NODE_ENV === "development"
}

/**
 * The only hostnames permitted to serve the widget: FSP_QUICKQUOTE_HOSTS,
 * comma-separated bare hostnames, NO default. An allow-list rather than a
 * deny-list of our own hosts: a new application hostname added later must
 * never silently become eligible to run FSP's bundle. A malformed entry is
 * dropped (never repaired), so a typo can only narrow the list.
 */
function urlHost(raw: string | undefined): string | null {
  try {
    return raw ? new URL(raw.trim()).hostname.toLowerCase() : null
  } catch {
    return null
  }
}

/**
 * Our own hosts, which must never serve the widget even when listed: the
 * staff app, client portal and website carry session cookies or frame the
 * widget, and a same-origin frame can reach its parent. Read from the same env
 * the rest of the deployment uses (lib/config/deployment-urls.ts), parsed here
 * because this module may not import.
 */
function ownHosts(env: Env): Set<string> {
  const hosts = [
    env.STAFF_APP_HOST?.trim().toLowerCase(),
    urlHost(env.NEXTAUTH_URL),
    urlHost(env.NEXT_PUBLIC_WEBSITE_URL),
    urlHost(env.NEXT_PUBLIC_PORTAL_URL),
    urlHost(env.NEXT_PUBLIC_PORTAL_LOGIN_URL),
    ...embeddingOrigins(env).map((origin) => urlHost(origin)),
  ]
  return new Set(hosts.filter((h): h is string => Boolean(h)))
}

function allowedHosts(env: Env): readonly string[] {
  const own = ownHosts(env)
  const hosts = listFrom(env, "FSP_QUICKQUOTE_HOSTS").filter((h) => HOSTNAME_PATTERN.test(h) && !own.has(h))
  if (hosts.length === 0) return []
  return isDevelopment(env) ? [...hosts, ...QUICKQUOTE_DEV_HOSTS] : hosts
}

/**
 * The marketing origins allowed to embed the widget: FSP_QUICKQUOTE_FRAME_ANCESTORS,
 * comma-separated https origins (scheme + host, no path), NO default.
 *
 * ONE list, consumed by two places that must agree: the insurance pages render
 * the panel only on these hosts, and next.config.ts builds the
 * `frame-ancestors` directive from them. A malformed or non-https entry is
 * dropped, and so is an entry carrying a path, wildcard or credentials.
 * `frame-ancestors` is baked into the build's headers, so this must be set at
 * build time as well as at runtime.
 */
function embeddingOrigins(env: Env): string[] {
  const origins: string[] = []
  for (const entry of listFrom(env, "FSP_QUICKQUOTE_FRAME_ANCESTORS")) {
    let parsed: URL
    try {
      parsed = new URL(entry)
    } catch {
      continue
    }
    if (parsed.protocol !== "https:" || parsed.origin !== entry) continue
    if (!HOSTNAME_PATTERN.test(parsed.hostname)) continue
    origins.push(parsed.origin)
  }
  return origins
}

/**
 * The origins allowed to frame the quote host, for `frame-ancestors`. Empty
 * when FSP_QUICKQUOTE_FRAME_ANCESTORS is unset or holds nothing valid.
 *
 * Kept beside the host gate deliberately — the two are edited together or the
 * panel and the CSP disagree again.
 */
export function quickQuoteFrameAncestors(env: Env = process.env): readonly string[] {
  const origins = embeddingOrigins(env)
  if (origins.length === 0) return []
  return isDevelopment(env)
    ? [...origins, ...QUICKQUOTE_DEV_HOSTS.map((host) => `http://${host}:*`)]
    : origins
}

/**
 * Whether the insurance page, served on `hostname`, may render the panel.
 *
 * `/site/*` is classified neither staff-only nor client-only, so the insurance
 * page is reachable on app.* and portal.* too. Offering the widget there would
 * point visitors at a frame those origins are not permitted to embed.
 */
export function isQuickQuoteEmbeddingHost(
  hostname: string | null | undefined,
  env: Env = process.env,
): boolean {
  if (!hostname) return false
  const origins = embeddingOrigins(env)
  if (origins.length === 0) return false
  const hosts = origins.map((origin) => new URL(origin).hostname)
  if (isDevelopment(env)) hosts.push(...QUICKQUOTE_DEV_HOSTS)
  return hosts.includes(hostname)
}

/**
 * Whether a request arriving on `hostname` may serve the widget.
 *
 * `hostname` must already be stripped of any port and lowercased by the
 * caller, the way proxy.ts derives `baseHostname`. False for every host while
 * FSP_QUICKQUOTE_HOSTS is unset.
 */
export function isQuickQuoteHost(
  hostname: string | null | undefined,
  env: Env = process.env,
): boolean {
  if (!hostname) return false
  return allowedHosts(env).includes(hostname)
}

/** Views FSP's script accepts for `initialView`. */
export const QUICKQUOTE_VIEWS = ["motor", "home", "building"] as const
export type QuickQuoteView = (typeof QUICKQUOTE_VIEWS)[number]

export const DEFAULT_QUICKQUOTE_VIEW: QuickQuoteView = "motor"

/** The four values FSP issues per broker. All four or nothing — see (1) above. */
export type QuickQuoteConfig = {
  ebc: string
  elead: string
  brokerContactEmail: string
  brokerName: string
}

function value(env: Env, key: string): string {
  return (env[key] ?? "").trim()
}

function isEnabled(env: Env): boolean {
  return value(env, "FSP_QUICKQUOTE_ENABLED") === "true"
}

/**
 * Whether the wizard may offer FSP's "more cars" control.
 *
 * Separate from `FSP_QUICKQUOTE_ENABLED` on purpose: this turns on a JOURNEY
 * change on a live lead surface, and it must be switchable off without taking
 * the whole quote embed down with it.
 */
export function isMultiVehicleEnabled(env: Env = process.env): boolean {
  return value(env, "FSP_QUICKQUOTE_MULTI_VEHICLE") === "true"
}

/**
 * Whether the quote surface offers the home-contents and buildings journeys.
 *
 * Separate from `FSP_QUICKQUOTE_ENABLED` for the same reason
 * `FSP_QUICKQUOTE_MULTI_VEHICLE` is: it opens two new journeys on a live lead
 * surface, and it must be switchable off without taking the motor quote —
 * which is the one that has been running — down with it.
 *
 * Exact-string comparison, like its neighbours: an unset or misspelt value
 * leaves the new journeys off rather than guessing that something truthy was
 * meant.
 */
export function isMultiRiskEnabled(env: Env = process.env): boolean {
  return value(env, "FSP_QUICKQUOTE_MULTI_RISK") === "true"
}

/**
 * Resolves the broker credentials, or null when the embed must not render.
 *
 * Returns null when the flag is off OR any single value is missing. The
 * all-or-nothing rule is the guard described in (1) above: three of four
 * values still produces a working widget that mails leads to FSP.
 */
export function resolveQuickQuoteConfig(
  env: Env = process.env,
): QuickQuoteConfig | null {
  if (!isEnabled(env)) return null

  const config: QuickQuoteConfig = {
    ebc: value(env, "FSP_QUICKQUOTE_EBC"),
    elead: value(env, "FSP_QUICKQUOTE_ELEAD"),
    brokerContactEmail: value(env, "FSP_QUICKQUOTE_BROKER_EMAIL"),
    brokerName: value(env, "FSP_QUICKQUOTE_BROKER_NAME"),
  }

  if (Object.values(config).some((v) => v === "")) return null

  return config
}

/**
 * Origin of the isolated host that renders the widget, e.g.
 * "https://quote.example.com" — the iframe `src` the marketing page
 * points at. Null whenever the embed must not be advertised.
 *
 * Requires the full credential set as well as the origin, deliberately. The
 * marketing page and the quote host are separate routes reading the same env,
 * so gating the page on the origin alone would let a half-configured deploy
 * advertise "Get instant quotes" over an iframe that 404s. One gate, applied
 * whole, in both places.
 *
 * The value becomes an iframe `src`, so it must be a well-formed https origin
 * AND its host must be on FSP_QUICKQUOTE_HOSTS. A scheme check alone is not
 * enough: `https://www.example.com` is a valid https origin, and
 * pointing the embed there would make the frame same-origin with its parent,
 * where `allow-scripts allow-same-origin` is escapable — FSP's bundle would
 * reach `window.parent.document` on our own marketing page, with nothing
 * visibly wrong. The allow-list is what actually prevents that.
 *
 * Outside production the loopback hosts are permitted so the surface can be
 * exercised locally; `http://` is still refused everywhere.
 */
/**
 * The frame's URL, including the plate the embedding page wants it to show.
 *
 * A pure function rather than a template literal at the call site because it is
 * the SENDING half of a contract whose receiving half (resolvePlate on the quote
 * host) is allow-listed and tested. Inline, the only coverage was on the
 * receiver, so dropping the encoding or naming the wrong view key would have
 * shipped with the suite green — the receiver would simply fall back to its
 * default plate and the two halves would silently disagree again, which is the
 * exact failure this whole contract exists to end.
 *
 * `plate` is omitted entirely when absent rather than sent empty, so the
 * receiver's fallback is reached by a missing parameter and not by a present
 * one it has to reject.
 */
export function buildQuoteFrameSrc(
  origin: string,
  view: QuickQuoteView,
  plate?: string,
): string {
  const base = `${origin}/quote?view=${view}`
  return plate ? `${base}&plate=${encodeURIComponent(plate)}` : base
}

export function resolveQuickQuoteEmbedOrigin(env: Env = process.env): string | null {
  if (!resolveQuickQuoteConfig(env)) return null

  const raw = value(env, "FSP_QUICKQUOTE_EMBED_ORIGIN")
  if (!raw) return null

  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }

  if (parsed.protocol !== "https:") return null
  if (!isQuickQuoteHost(parsed.hostname, env)) return null

  return parsed.origin
}

/**
 * The single gate the quote host itself uses: credentials to render the
 * widget, or null if this request must 404.
 *
 * Requires the full config, a valid embed origin, AND that the request
 * actually arrived on an allow-listed quote host. All three, because each
 * alone has been shown to be insufficient:
 *
 *  - config alone let /quote serve while FSP_QUICKQUOTE_EMBED_ORIGIN was
 *    unset, so the marketing page went dark while the quote host stayed live
 *    — the opposite of the "all five or nothing" rule this module states.
 *  - neither checked the request host, so /quote served FSP's script on
 *    app.* and portal.*, beside staff and client session cookies.
 */
export function resolveQuickQuoteHostConfig(
  hostname: string | null | undefined,
  env: Env = process.env,
): QuickQuoteConfig | null {
  if (!isQuickQuoteHost(hostname, env)) return null
  if (!resolveQuickQuoteEmbedOrigin(env)) return null
  return resolveQuickQuoteConfig(env)
}

export function isQuickQuoteView(value: unknown): value is QuickQuoteView {
  return QUICKQUOTE_VIEWS.includes(value as QuickQuoteView)
}
