/**
 * Where an IsaFlow connection may point. The base URL is typed by a lender's
 * SUPER_ADMIN, so it is untrusted: it must be an origin this deployment's
 * operator listed in ISAFLOW_ALLOWED_ORIGINS (comma-separated, e.g.
 * "https://app.isaflow.co.za"), and an https one must resolve only to public
 * addresses (lib/lender-api/webhooks/ssrf.ts), checked again before every
 * request and inside the connection's own lookup (./dial.ts). Plain http is accepted for a loopback origin only, only when it is
 * listed, and only under NODE_ENV test or development (the fake IsaFlow).
 */
import { resolvePublic, systemResolver, type Resolver } from "@/lib/lender-api/webhooks/ssrf"

export class IsaFlowUrlError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "IsaFlowUrlError"
  }
}

export function allowedIsaFlowOrigins(env: NodeJS.ProcessEnv = process.env): string[] {
  return (env.ISAFLOW_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => {
      try {
        return [new URL(s).origin]
      } catch {
        return []
      }
    })
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"])
const bare = (hostname: string) => hostname.replace(/^\[|\]$/g, "")

/** The origin of `raw`, when it is one this deployment allows; throws IsaFlowUrlError otherwise. No DNS here. */
export function isaflowOrigin(raw: unknown, env: NodeJS.ProcessEnv = process.env): string {
  if (typeof raw !== "string" || raw.length > 2048) throw new IsaFlowUrlError("Give the IsaFlow address, e.g. https://app.isaflow.co.za")
  let url: URL
  try {
    url = new URL(raw.trim())
  } catch {
    throw new IsaFlowUrlError("The IsaFlow address is not a valid URL")
  }
  if (url.username || url.password) throw new IsaFlowUrlError("The IsaFlow address must not contain credentials")
  if (url.pathname !== "/" || url.search || url.hash) throw new IsaFlowUrlError("Give only the IsaFlow address (scheme, host and port), without a path")
  const loopback = LOOPBACK.has(bare(url.hostname))
  if (url.protocol === "http:") {
    const devOrTest = env.NODE_ENV === "test" || env.NODE_ENV === "development"
    if (!loopback || !devOrTest) throw new IsaFlowUrlError("The IsaFlow address must use https")
  } else if (url.protocol !== "https:") {
    throw new IsaFlowUrlError("The IsaFlow address must use https")
  }
  const allowed = allowedIsaFlowOrigins(env)
  if (allowed.length === 0) throw new IsaFlowUrlError("IsaFlow is not set up on this deployment (ISAFLOW_ALLOWED_ORIGINS)")
  if (!allowed.includes(url.origin)) throw new IsaFlowUrlError(`${url.origin} is not an IsaFlow address this deployment allows`)
  return url.origin
}

/** isaflowOrigin plus the DNS check: an https host must resolve only to public addresses. */
export async function assertIsaFlowOrigin(raw: unknown, env: NodeJS.ProcessEnv = process.env, resolve: Resolver = systemResolver): Promise<string> {
  const origin = isaflowOrigin(raw, env)
  const url = new URL(origin)
  // http passed isaflowOrigin only as a listed loopback origin outside production.
  if (url.protocol === "https:") {
    try {
      await resolvePublic(url.hostname, resolve)
    } catch (error) {
      throw new IsaFlowUrlError(`${url.hostname} is not a public address (${error instanceof Error ? error.message : "refused"})`)
    }
  }
  return origin
}
