// DEMO_MODE is a server-side runtime env var (never NEXT_PUBLIC_), so one image
// serves both the demo and a normal deployment. Anything but the literal
// string "true" is off.
export function isDemoMode(env: Record<string, string | undefined> = process.env): boolean {
  return env.DEMO_MODE?.trim().toLowerCase() === "true"
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
