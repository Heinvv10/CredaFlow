import { DeploymentConfigError } from "@/lib/config/deployment-urls"

// Read as a literal `process.env.X` so Next inlines it into the client bundle
// (the only caller is a client component). No default: a link is never built
// against another deployment's host.
function websiteOrigin(): string {
  const origin = process.env.NEXT_PUBLIC_WEBSITE_URL?.trim()
  if (!origin) throw new DeploymentConfigError("NEXT_PUBLIC_WEBSITE_URL is not set.")
  return origin
}

/**
 * The link an agent shares. Product-neutral: /site/apply already reads `?ref=`
 * and attributes across every product.
 */
export function buildReferralLink(code: string, origin: string = websiteOrigin()): string {
  const trimmed = code.trim()
  // An unattributed link is worse than no link — it earns the agent nothing and
  // nobody notices until commission is queried.
  if (!trimmed) throw new Error("Referral code is required to build a link")
  // Strip a trailing slash so a caller-supplied origin (e.g. an environment override)
  // can't double up into `//site/apply`, which Next.js 404s rather than failing loudly.
  return `${origin.replace(/\/$/, "")}/site/apply?ref=${encodeURIComponent(trimmed)}`
}
