// DEMO_MODE is a server-side runtime env var (never NEXT_PUBLIC_), so one image
// serves both the demo and a normal deployment. Anything but the exact string
// "true" is off — no trimming, no case folding — because the same switch
// decides whether a one-time code may appear in a response (demoCodeReveal).
export function isDemoMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE === "true"
}

export const DEMO_ROBOTS_HEADER = "noindex, nofollow"

/** Stamps the demo-only no-index header on a response; a no-op when demo mode is off. */
export function applyDemoHeaders<T extends Response>(
  res: T,
  env: Record<string, string | undefined> = process.env,
): T {
  if (isDemoMode(env)) res.headers.set("X-Robots-Tag", DEMO_ROBOTS_HEADER)
  return res
}

export const DEMO_BANNER_FALLBACK =
  "Demo environment — this is a fictional lender. Do not enter real personal information."

export function demoBannerText(brandName: string | null): string {
  return brandName
    ? `Demo environment — ${brandName} is a fictional lender. Do not enter real personal information.`
    : DEMO_BANNER_FALLBACK
}

/** RFC 2606 reserves `.invalid`: mail to it can never be delivered. */
const UNDELIVERABLE_DOMAIN_SUFFIX = ".invalid"

/**
 * A demo borrower's one-time codes (portal activation, password reset) are
 * emailed to fictional `.invalid` addresses and never arrive, so in a demo the
 * route that issues a code returns it to that same request for the screen to
 * show. Both conditions are required: demo mode on (exact "true"), AND the
 * address the code was issued to is a `.invalid` one. A real address typed
 * into the public demo — or any account on a deployment that has DEMO_MODE
 * set by mistake — therefore never gets its code in the response, so the
 * reveal can't be used to take over or enumerate a deliverable mailbox.
 */
export function demoCodeReveal(
  code: string,
  recipientEmail: string,
  env: Record<string, string | undefined> = process.env,
): { demoCode?: string } {
  if (!isDemoMode(env)) return {}
  const email = recipientEmail.trim().toLowerCase()
  // One mailbox only: a list ("real@gmail.com, x@y.invalid") would also mail the real address.
  const oneMailbox = email.split("@").length === 2 && !/[,;\s]/.test(email)
  return oneMailbox && email.endsWith(UNDELIVERABLE_DOMAIN_SUFFIX) ? { demoCode: code } : {}
}
