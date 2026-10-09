// Canonical client-portal URLs. The portal is served from its own host, so
// email buttons and cross-app links MUST target that host, not the app's own
// origin.
//
// NOTE: the staff app does NOT 404 /portal/*. `app` and `app-portal` run the
// SAME image, so a staff-origin /portal/agreement/... link resolves and renders
// the client login form perfectly well. It *works*, silently, while putting
// consumers on the staff container and defeating the point of a separate
// mode:client build. The host being wrong is not self-announcing — it has to
// be got right here.
//
// The base comes from env only (lib/config/deployment-urls.ts) and has no
// default: every helper below throws DeploymentConfigError when it is unset,
// rather than pointing a customer at another deployment's portal.
import { DeploymentConfigError, requirePortalBaseUrl } from "@/lib/config/deployment-urls"

/**
 * Validate a caller-supplied post-auth destination.
 *
 * Returns the path when it is a safe same-origin portal path, else null.
 * This value reaches a redirect Location and a client-side router.push, so it
 * is an open-redirect sink: an allowlist is the only safe shape.
 *
 * Requiring the literal `/portal/` prefix is what rejects the protocol-relative
 * `//evil.example` form — that string cannot start with `/portal/`. The
 * character class then excludes `\` (browsers normalise it to `/`, so
 * `/portal/\evil.example` would otherwise escape the origin), `:` (scheme), and
 * `?`/`#`. No destination we emit needs a query string, so nothing is lost by
 * refusing one.
 *
 * The `..` check is not redundant with the prefix: `.` has to stay in the
 * character class, so `/portal/../admin` satisfies the regex and then
 * normalises to `/admin` in the browser — inside our origin, but outside the
 * `/portal/` subtree this function exists to promise. Caught by its own test.
 */
export function safePortalPath(raw: string | null | undefined): string | null {
  if (!raw || raw.includes("..")) return null
  return /^\/portal\/[A-Za-z0-9\-._~/]*$/.test(raw) ? raw : null
}

/**
 * Portal login URL that lands the customer on `callbackPath` after
 * authenticating. Use for customers who already have a portal password.
 * Pass `null` for a bare login URL with no `callbackUrl` query param (e.g.
 * marketing CTAs where the default post-login redirect is already correct).
 */
export function portalLoginUrl(callbackPath: string | null = "/portal/applications"): string {
  if (callbackPath === null) return `${requirePortalBaseUrl()}/portal/login`
  return `${requirePortalBaseUrl()}/portal/login?callbackUrl=${encodeURIComponent(callbackPath)}`
}

/**
 * Portal registration URL with the applicant's email + application reference
 * pre-filled. Use for a client who has applied but not yet set a portal
 * password (portalPassword is null) — sending them to /portal/login instead
 * would be a dead end (the login page has no register link). Mirrors the
 * on-page success-screen link in app/(website)/site/apply/page.tsx.
 */
export function portalRegisterUrl(email: string, reference: string): string {
  return `${requirePortalBaseUrl()}/portal/register?email=${encodeURIComponent(email)}&reference=${encodeURIComponent(reference)}`
}

/**
 * Portal "my documents" URL. Use for marketing CTAs that send an existing
 * client straight to their document list rather than the login form.
 */
export function portalDocumentsUrl(): string {
  return `${requirePortalBaseUrl()}/portal/documents`
}

/**
 * Smart portal entry for email CTAs. Instead of baking the login-vs-register
 * choice at send time (which can be stale — e.g. the customer registers between
 * the email going out and clicking it), point every email button here: the
 * /portal/continue route checks account state at CLICK time and 302s to login
 * (password set) or register (prefilled). Always pass the application reference —
 * the route matches email+reference to a real application before revealing which
 * way to route, so it can't be used to enumerate which emails are customers.
 *
 * `next` is the portal path to land on once the customer is authenticated. Pass
 * it for deep links (e.g. a specific agreement to sign): without it the customer
 * lands on the applications list and has to find their way, and a customer who
 * has not registered yet lands there having lost the destination entirely.
 * Silently dropped unless it passes `safePortalPath`.
 */
export function portalContinueUrl(email: string, reference: string, next?: string): string {
  const params = new URLSearchParams({ email })
  if (reference) params.set("reference", reference)
  const safeNext = safePortalPath(next)
  if (safeNext) params.set("next", safeNext)
  return `${requirePortalBaseUrl()}/portal/continue?${params.toString()}`
}

/**
 * For surfaces that can simply leave a portal link out (page CTAs, staff
 * "copy link" buttons): the URL, or null when the deployment has no portal URL
 * configured. Any other error propagates. Never substitutes a host.
 */
export function portalUrlOrNull(build: () => string): string | null {
  try {
    return build()
  } catch (e) {
    if (e instanceof DeploymentConfigError) return null
    throw e
  }
}
