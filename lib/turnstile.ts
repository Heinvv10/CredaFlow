/**
 * Cloudflare Turnstile verification — used as bot defence on the public
 * website forms (apply, contact). Free, privacy-friendly, no user friction.
 *
 * Setup:
 *   - Register a site at https://dash.cloudflare.com/?to=/:account/turnstile
 *   - Set TURNSTILE_SECRET_KEY (server) and NEXT_PUBLIC_TURNSTILE_SITE_KEY (client)
 *
 * Dev bypass: set TURNSTILE_DEV_BYPASS=1 explicitly to skip verification in
 * non-production environments. Without this flag, TURNSTILE_SECRET_KEY is
 * required at all times — a missing secret fails closed in production and
 * returns an error in other environments. This prevents a misconfigured
 * pre-production container (NODE_ENV=development but publicly reachable) from
 * silently accepting unchallenged traffic.
 */

const SITEVERIFY_URL = "https://challenges.cloudflare.com/turnstile/v0/siteverify"
const TURNSTILE_TEST_SECRET_PREFIXES = ["1x000", "2x000", "3x000"]

let warnedMissingSecret = false
let warnedTestSecret = false

function isTurnstileTestSecret(secret: string | undefined) {
  return Boolean(
    secret &&
      TURNSTILE_TEST_SECRET_PREFIXES.some((prefix) => secret.startsWith(prefix)),
  )
}

function isTurnstileTestSiteKey(siteKey: string | undefined) {
  return Boolean(
    siteKey &&
      TURNSTILE_TEST_SECRET_PREFIXES.some((prefix) => siteKey.startsWith(prefix)),
  )
}

function normaliseTurnstileRemoteIp(ip: string | null): string | null {
  if (!ip || ip === "unknown") return null
  const candidate = ip.trim()
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(candidate)) {
    const octets = candidate.split(".").map(Number)
    return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255)
      ? candidate
      : null
  }
  if (/^[0-9a-f:]+$/i.test(candidate) && candidate.includes(":")) return candidate
  return null
}

export interface TurnstileResult {
  ok: boolean
  /** Cloudflare error codes if verification failed. */
  errorCodes?: string[]
}

export async function verifyTurnstile(
  token: string | undefined | null,
  ip: string | null,
): Promise<TurnstileResult> {
  const secret = process.env.TURNSTILE_SECRET_KEY

  if (isTurnstileTestSecret(secret)) {
    if (!warnedTestSecret) {
      console.warn("[turnstile] Cloudflare test secret configured; verification bypassed until real keys are provisioned.")
      warnedTestSecret = true
    }
    return { ok: true }
  }

  // Bypass decided entirely from OUR OWN config (never from client input): if
  // the public site key is still a Cloudflare test key — even though the
  // secret above is already a real one, mid key-rotation — the widget emits a
  // placeholder token the real siteverify endpoint would legitimately reject.
  // A client-supplied token must never be able to influence this decision
  // (e.g. a literal "dev-bypass" string), since NEXT_PUBLIC_* env vars are
  // readable by anyone and Cloudflare's test-key prefixes are public.
  if (isTurnstileTestSiteKey(process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY)) {
    if (!warnedTestSecret) {
      console.warn("[turnstile] Test site key configured; accepting all requests until real Turnstile keys are provisioned.")
      warnedTestSecret = true
    }
    return { ok: true }
  }

  if (!secret) {
    const devBypass = process.env.TURNSTILE_DEV_BYPASS === "1" && process.env.NODE_ENV !== "production"
    if (!warnedMissingSecret) {
      if (!devBypass) {
        // No secret + no explicit bypass → fail closed and log.
        console.error("[turnstile] TURNSTILE_SECRET_KEY is not set and TURNSTILE_DEV_BYPASS is not enabled — bot defence is OFF.")
      } else {
        console.warn("[turnstile] TURNSTILE_DEV_BYPASS=1 — verification bypassed (dev mode).")
      }
      warnedMissingSecret = true
    }
    return devBypass ? { ok: true } : { ok: false, errorCodes: ["missing-secret"] }
  }

  if (!token) {
    return { ok: false, errorCodes: ["missing-token"] }
  }

  const body = new URLSearchParams({ secret, response: token })
  const verifiedIp = normaliseTurnstileRemoteIp(ip)
  if (verifiedIp) body.set("remoteip", verifiedIp)

  try {
    const res = await fetch(SITEVERIFY_URL, {
      method: "POST",
      body,
      // Short timeout so a Cloudflare blip can't stall a request.
      signal: AbortSignal.timeout(5000),
    })

    if (!res.ok) {
      return { ok: false, errorCodes: [`http-${res.status}`] }
    }

    const data = (await res.json()) as { success: boolean; "error-codes"?: string[] }
    return {
      ok: data.success === true,
      errorCodes: data["error-codes"],
    }
  } catch (err) {
    // Network failure / timeout. We fail closed in production but log for triage.
    console.error("[turnstile] siteverify failed:", err)
    return { ok: false, errorCodes: ["network-error"] }
  }
}
