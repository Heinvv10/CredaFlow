/**
 * A lender's custom domain (Tenant.domain). Host resolution checks it BEFORE
 * the slug the edge derived from the host (lib/tenant.ts), so a domain naming
 * a host this deployment already serves — the console, the staff or portal
 * host, a TENANT_HOST_MAP host, another lender's subdomain-fallback host —
 * would hand that host to the new lender. Every write of Tenant.domain
 * (operator console provisioning, the admin tenants API) normalises it here
 * and asks tenantDomainRefusal first.
 */
import type { Prisma } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { isQuickQuoteEmbeddingHost, isQuickQuoteHost } from "@/lib/insurance/quickquote-config"
import { normaliseHost, operatorAppHost, parseTenantHostMap, staffAppHost } from "./deployment-urls"

/** The one query the host rules make; the app client and the CLI's transaction both fit. */
export type TenantHostLookup = {
  tenant: {
    findFirst(args: { where: Prisma.TenantWhereInput; select: { slug: true; domain: true } }): PromiseLike<{ slug: string; domain: string | null } | null>
  }
}

const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export type DomainParse = { ok: true; domain: string | null } | { ok: false; error: string }

/** Lower-case, trimmed, no trailing dot; blank or null is "no domain". */
export function normaliseTenantDomain(raw: unknown): DomainParse {
  if (raw === null || raw === undefined) return { ok: true, domain: null }
  if (typeof raw !== "string") return { ok: false, error: "domain must be a hostname or null" }
  const domain = raw.trim().toLowerCase().replace(/\.$/, "")
  if (!domain) return { ok: true, domain: null }
  if (!HOSTNAME.test(domain)) return { ok: false, error: "domain must be a lower-case hostname such as loans.lender.example" }
  return { ok: true, domain }
}

const URL_VARS = [
  "NEXTAUTH_URL", "AUTH_URL", "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_PORTAL_URL", "NEXT_PUBLIC_PORTAL_LOGIN_URL",
  "NEXT_PUBLIC_PORTAL_ORIGIN", "PORTAL_PUBLIC_ORIGIN", "NEXT_PUBLIC_WEBSITE_URL", "FSP_QUICKQUOTE_EMBED_ORIGIN",
] as const
/** Comma-separated lists: bare hosts, and origins (FSP QuickQuote, lib/insurance/quickquote-config.ts). */
const HOST_LIST_VARS = ["FSP_QUICKQUOTE_HOSTS"] as const
const ORIGIN_LIST_VARS = ["FSP_QUICKQUOTE_FRAME_ANCESTORS"] as const

const list = (raw: string | undefined) => (raw ?? "").split(",").map((v) => v.trim()).filter(Boolean)

function urlHost(value: string): string | null {
  try {
    return normaliseHost(new URL(value).host)
  } catch {
    // Not a URL: the module that reads it refuses it where it is used.
    return null
  }
}

/** Hosts this deployment serves by configuration, which no lender's domain may claim. */
export function reservedDeploymentHosts(env: Readonly<Record<string, string | undefined>> = process.env): Set<string> {
  const hosts = new Set<string>(Object.keys(parseTenantHostMap(env.TENANT_HOST_MAP)))
  for (const host of [operatorAppHost(env), staffAppHost(env)]) if (host) hosts.add(host)
  for (const name of URL_VARS) {
    const host = env[name]?.trim() ? urlHost(env[name]!.trim()) : null
    if (host) hosts.add(host)
  }
  for (const name of HOST_LIST_VARS) for (const host of list(env[name])) hosts.add(normaliseHost(host))
  for (const name of ORIGIN_LIST_VARS) {
    for (const origin of list(env[name])) {
      const host = urlHost(origin)
      if (host) hosts.add(host)
    }
  }
  return hosts
}

/**
 * Whether the deployment serves `domain` itself: the configured hosts above,
 * and whatever the proxy's own QuickQuote classifiers say they serve, so the
 * two cannot drift (lib/config/tenant-domain.test.ts checks every host
 * variable the proxy reads).
 */
export function isReservedDeploymentHost(domain: string, env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return reservedDeploymentHosts(env).has(domain) || isQuickQuoteHost(domain, env) || isQuickQuoteEmbeddingHost(domain, env)
}

/**
 * Why `domain` (normalised) may not be `tenantId`'s, or null. `tenantId` is
 * null for a lender not yet created.
 */
export async function tenantDomainRefusal(domain: string, tenantId: string | null, db: TenantHostLookup = prisma): Promise<string | null> {
  if (isReservedDeploymentHost(domain)) return `domain ${domain} is a host this deployment already serves`
  const others = tenantId ? { NOT: { id: tenantId } } : {}
  // proxy.ts resolves an unmapped 3+-label host to the slug in its first label.
  const labels = domain.split(".")
  if (labels.length >= 3) {
    const owner = await db.tenant.findFirst({ where: { slug: labels[0], ...others }, select: { slug: true, domain: true } })
    if (owner) return `domain ${domain} is lender "${owner.slug}"'s subdomain host`
  }
  const holder = await db.tenant.findFirst({ where: { domain, ...others }, select: { slug: true, domain: true } })
  if (holder) return `domain ${domain} already belongs to another lender`
  return null
}

/**
 * The reverse: a new lender's subdomain host (`<slug>.<base>`, proxy.ts's
 * fallback) must not be a 3+-label domain another lender already holds — the
 * domain would win and the new lender's host would serve the other lender.
 */
export async function tenantSlugRefusal(slug: string, db: TenantHostLookup = prisma): Promise<string | null> {
  const holder = await db.tenant.findFirst({ where: { domain: { startsWith: `${slug}.` } }, select: { slug: true, domain: true } })
  if (holder?.domain && holder.domain.split(".").length >= 3) {
    return `slug ${slug}: its subdomain host would be ${holder.domain}, lender "${holder.slug}"'s domain`
  }
  return null
}
