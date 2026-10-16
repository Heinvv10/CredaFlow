// DEMO_MODE is a server-side runtime env var (never NEXT_PUBLIC_), so one image
// serves both the demo and a normal deployment. Anything but the exact string
// "true" is off — no trimming, no case folding — because the same switch
// decides whether a one-time code may appear in a response (demoCodeReveal).
export function isDemoMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE === "true"
}

/**
 * A demo stack whose staff sign in without TOTP (restore.sh clears it when the
 * app runs with DEMO_CLEAR_STAFF_TOTP=true). Only there may clearing a credit
 * check (app/api/applications/[id]/checks/[flagId]/clear) accept a
 * password-only session; both switches must be exactly "true". Never on a
 * real lender.
 */
export function demoStaffWithoutTotp(env: Record<string, string | undefined> = process.env): boolean {
  return isDemoMode(env) && env.DEMO_CLEAR_STAFF_TOTP === "true"
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
  "Demo environment — all data shown is sample data. Do not enter real personal information."

/**
 * Printed beside a demo lender's NCR and FSP numbers (site footer, regulatory
 * page, portal): a demo lender holds fictional registrations. Not on NCA
 * documents, whose text is fixed (lib/pdf).
 */
export const DEMO_LENDER_NOTE = "Demo lender: registration numbers are fictional."

export function demoLenderNote(env: Record<string, string | undefined> = process.env): string | null {
  return isDemoMode(env) ? DEMO_LENDER_NOTE : null
}

export function demoBannerText(brandName: string | null): string {
  return brandName
    ? `${brandName} demo — all data shown is sample data. Do not enter real personal information.`
    : DEMO_BANNER_FALLBACK
}

/**
 * RFC 2606 reserves `.invalid`: mail to it can never be delivered. An
 * allow-list, not a deny-list: one plain mailbox (no display name, quotes,
 * angle brackets or lists) whose domain ends in `.invalid`.
 */
const UNDELIVERABLE_MAILBOX = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.invalid$/

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
  return UNDELIVERABLE_MAILBOX.test(email) ? { demoCode: code } : {}
}
