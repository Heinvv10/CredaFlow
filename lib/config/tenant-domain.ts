/**
 * A lender's custom domain (Tenant.domain). Host resolution checks it BEFORE
 * the slug the edge derived from the host (lib/tenant.ts), so a domain naming
 * a host this deployment already serves — the console, the staff or portal
 * host, a TENANT_HOST_MAP host, another lender's subdomain-fallback host —
 * would hand that host to the new lender. Every write of Tenant.domain
 * (operator console provisioning, the admin tenants API) normalises it here
 * and asks tenantDomainRefusal first.
 */
import { prisma } from "@/lib/prisma"
import { normaliseHost, operatorAppHost, parseTenantHostMap, staffAppHost } from "./deployment-urls"

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
  "NEXT_PUBLIC_PORTAL_ORIGIN", "PORTAL_PUBLIC_ORIGIN", "NEXT_PUBLIC_WEBSITE_URL",
] as const

/** Hosts this deployment serves by configuration, which no lender's domain may claim. */
export function reservedDeploymentHosts(env: Readonly<Record<string, string | undefined>> = process.env): Set<string> {
  const hosts = new Set<string>(Object.keys(parseTenantHostMap(env.TENANT_HOST_MAP)))
  for (const host of [operatorAppHost(env), staffAppHost(env)]) if (host) hosts.add(host)
  for (const name of URL_VARS) {
    const value = env[name]?.trim()
    if (!value) continue
    try {
      hosts.add(normaliseHost(new URL(value).host))
    } catch {
      // Not a URL: deployment-urls.ts refuses it where it is used.
    }
  }
  return hosts
}

/**
 * Why `domain` (normalised) may not be `tenantId`'s, or null. `tenantId` is
 * null for a lender not yet created.
 */
export async function tenantDomainRefusal(domain: string, tenantId: string | null): Promise<string | null> {
  if (reservedDeploymentHosts().has(domain)) return `domain ${domain} is a host this deployment already serves`
  const others = tenantId ? { NOT: { id: tenantId } } : {}
  // proxy.ts resolves an unmapped 3+-label host to the slug in its first label.
  const labels = domain.split(".")
  if (labels.length >= 3) {
    const owner = await prisma.tenant.findFirst({ where: { slug: labels[0], ...others }, select: { slug: true } })
    if (owner) return `domain ${domain} is lender "${owner.slug}"'s subdomain host`
  }
  const holder = await prisma.tenant.findFirst({ where: { domain, ...others }, select: { slug: true } })
  if (holder) return `domain ${domain} already belongs to another lender`
  return null
}
