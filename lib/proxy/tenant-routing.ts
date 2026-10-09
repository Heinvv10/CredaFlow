import type { NextRequest } from "next/server"

import { normaliseHost, parseTenantHostMap } from "@/lib/config/deployment-urls"

// Public hostnames → tenant slugs, from TENANT_HOST_MAP (env only, no
// defaults; lib/config/deployment-urls.ts). Tenant routing is derived from the
// request host, never from a caller-supplied x-tenant-slug header.
//
// Every host a deployment serves on a 3+-label name needs an entry: without
// one the subdomain fallback below resolves e.g. "quote.lender.example" to the
// slug "quote", which names no tenant, and every request fails tenant lookup.
export function resolveTenantSlug(req: NextRequest): string | null {
  const baseHostname = normaliseHost(req.headers.get("host") ?? "")
  const mapped = parseTenantHostMap(process.env.TENANT_HOST_MAP)[baseHostname]
  if (mapped) return mapped

  const isLocal =
    baseHostname === "localhost" || baseHostname === "127.0.0.1"

  if (!isLocal) {
    const parts = baseHostname.split(".")
    if (parts.length >= 3) {
      return parts[0]
    }

    return null
  }

  // Local development: the deployment's own tenant, never a caller's claim.
  return process.env.NEXT_PUBLIC_TENANT_SLUG?.trim() || null
}

/**
 * Builds the request headers passed to application code from the edge-resolved
 * tenant. The caller-provided value is always removed before the trusted value
 * is applied.
 */
export function buildTenantHeaders(
  req: NextRequest,
  tenantSlug: string | null,
): Headers {
  const requestHeaders = new Headers(req.headers)
  requestHeaders.delete("x-tenant-slug")
  if (tenantSlug) {
    requestHeaders.set("x-tenant-slug", tenantSlug)
  }
  return requestHeaders
}
