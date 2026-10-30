import { prisma } from "./prisma"
import { unstable_cache } from "next/cache"
import { cache } from "react"
import { headers } from "next/headers"
import type { NextRequest } from "next/server"
import type { TenantStatus } from "@prisma/client"
import { getCurrentTenantId, runWithTenant } from "./tenant-scope"
import { normaliseHost } from "./config/deployment-urls"
import { isNcaJurisdiction } from "./jurisdiction/active"
import { ensureActiveJurisdiction } from "./jurisdiction/load.server"

export type TenantContext = {
  id: string
  slug: string
  name: string
  domain: string | null
  status: TenantStatus
}

export type TenantConfigData = {
  id: string
  tenantId: string
  primaryColor: string
  secondaryColor: string
  darkColor: string
  logoUrl: string | null
  faviconUrl: string | null
  brandName: string | null
  featureLms: boolean
  featureCrm: boolean
  featureIms: boolean
  featureBureauSubmission: boolean
  featureMarketing: boolean
  featurePortal: boolean
  featureReports: boolean
  featureAssetFinance: boolean
  ncrNumber: string | null
  fscaNumber: string | null
  companyRegNumber: string | null
  /** Raw column; read through lib/i18n/locales.ts normaliseEnabledLocales. */
  enabledLanguages: string[]
  /** Raw JSON; read through lib/i18n/language-reviews.ts servableLocales. */
  languageReviews: unknown
}

export async function getTenantFromRequest(
  req: NextRequest | Request
): Promise<TenantContext | null> {
  // Normalised as Tenant.domain is stored (lib/config/tenant-domain.ts): a
  // Host is case-insensitive and may carry a trailing dot.
  const baseHostname = normaliseHost(req.headers.get("host") ?? "")

  // 1. Check if hostname matches a known custom domain
  const isLocalhost =
    baseHostname === "localhost" || baseHostname === "127.0.0.1"

  if (!isLocalhost) {
    const byDomain = await prisma.tenant.findFirst({
      where: { domain: baseHostname, status: "ACTIVE" },
      select: { id: true, slug: true, name: true, domain: true, status: true },
    })
    if (byDomain) return byDomain
  }

  // 2. Check x-tenant-slug header (set by middleware or caller)
  const slugFromHeader = req.headers.get("x-tenant-slug")
  if (slugFromHeader) {
    const bySlug = await prisma.tenant.findUnique({
      where: { slug: slugFromHeader },
      select: { id: true, slug: true, name: true, domain: true, status: true },
    })
    if (bySlug?.status === "ACTIVE") return bySlug
  }

  // 3. Fall back to NEXT_PUBLIC_TENANT_SLUG env var
  const slugFromEnv = process.env.NEXT_PUBLIC_TENANT_SLUG
  if (slugFromEnv) {
    const byEnv = await prisma.tenant.findUnique({
      where: { slug: slugFromEnv },
      select: { id: true, slug: true, name: true, domain: true, status: true },
    })
    if (byEnv) return byEnv
  }

  // 4. Single-tenant fallback. A deployment serves one lender, so
  // when host/header/env all miss we pick the only active tenant rather than
  // returning a 400. Guarded by exact-count to keep multi-tenant deployments
  // safe — if a second tenant appears, this branch stops triggering and the
  // operator is forced to wire up proper tenant routing.
  const activeTenants = await prisma.tenant.findMany({
    where: { status: "ACTIVE" },
    select: { id: true, slug: true, name: true, domain: true, status: true },
    take: 2,
  })
  if (activeTenants.length === 1) {
    return activeTenants[0]
  }

  return null
}

export async function getTenantBySlug(
  slug: string
): Promise<TenantContext | null> {
  return prisma.tenant.findUnique({
    where: { slug },
    select: { id: true, slug: true, name: true, domain: true, status: true },
  })
}

/**
 * Resolve the tenant id for background jobs that have no incoming request
 * (cron, scheduled tasks). Looks up by the NEXT_PUBLIC_TENANT_SLUG env var,
 * which has no default. Throws if it is unset or no tenant matches — callers
 * should not try to invent an ID.
 *
 * Single-tenant assumption today; revisit when introducing a second tenant.
 */
export async function getDefaultTenantId(): Promise<string> {
  await ensureActiveJurisdiction()
  const slug = process.env.NEXT_PUBLIC_TENANT_SLUG?.trim()
  if (!slug) {
    throw new Error("Default tenant is not configured: NEXT_PUBLIC_TENANT_SLUG is unset")
  }
  const tenant = await prisma.tenant.findUnique({
    where: { slug },
    select: { id: true },
  })
  if (!tenant) {
    throw new Error(`Default tenant not found for slug "${slug}"`)
  }
  return tenant.id
}

export function getTenantConfig(tenantId: string) {
  return unstable_cache(
    async (): Promise<TenantConfigData | null> => {
      return prisma.tenantConfig.findUnique({
        where: { tenantId },
        select: {
          id: true,
          tenantId: true,
          primaryColor: true,
          secondaryColor: true,
          darkColor: true,
          logoUrl: true,
          faviconUrl: true,
          brandName: true,
          featureLms: true,
          featureCrm: true,
          featureIms: true,
          featureBureauSubmission: true,
          featureMarketing: true,
          featurePortal: true,
          featureReports: true,
          featureAssetFinance: true,
          ncrNumber: true,
          fscaNumber: true,
          companyRegNumber: true,
          enabledLanguages: true,
          languageReviews: true,
        },
      })
    },
    [`tenant-config-${tenantId}`],
    { revalidate: 300, tags: [`tenant-config-${tenantId}`] }
  )()
}

/**
 * Server-Component / server-action-safe tenant resolver.
 * Reads the ALS context (set by runWithTenant) if available; otherwise falls
 * back to getDefaultTenantId().
 *
 * Use this in NEW code where the enforcer's ALS context should follow through
 * to Prisma calls. Existing routes can keep using getDefaultTenantId() directly
 * — explicit where: { tenantId } predicates are still honored by the enforcer.
 *
 * Caching: React.cache memoizes within a Server Component render tree only.
 * In Route Handlers (app/api/**) and Server Actions invoked outside an RSC
 * render, every call re-resolves — that is fine, the DB round-trip is one
 * Tenant lookup. Use getDefaultTenantId() directly if you want explicit control.
 */
export const getResolvedTenantId = cache(async (): Promise<string> => {
  await ensureActiveJurisdiction()
  const fromAls = getCurrentTenantId()
  if (fromAls) return fromAls

  // Mirrors getTenantFromRequest's precedence — domain, then `x-tenant-slug`,
  // then the env default — so a Server Component and the API it posts to cannot
  // resolve different tenants. Without this a page resolved from the
  // BUILD-BAKED NEXT_PUBLIC_TENANT_SLUG while the API resolved from the request
  // host: on a second tenant the page reads tenant A's rows and its save writes
  // them to tenant B.
  //
  // The header is trustworthy because proxy.ts derives it from the host and
  // deletes any inbound copy; it is the edge's answer, not the caller's.
  let host: string | null = null
  let slug: string | null = null
  try {
    const h = await headers()
    host = h.get("host")
    slug = h.get("x-tenant-slug")
  } catch {
    // No request scope (server action at build, unit test) — fall through.
  }

  // Everything below is deliberately OUTSIDE that try: a failed lookup must not
  // be swallowed into "use the default tenant", which would serve one tenant's
  // data to another silently. Only the missing-request-scope case falls back.

  // 1. Custom domain. getTenantFromRequest checks this FIRST, and Tenant.domain
  //    is settable from the admin API — a domain-mapped tenant would otherwise
  //    be invisible here while the API resolved it fine.
  // Normalised the same way proxy.ts normalises it — a Host is case-insensitive
  // and may carry a trailing dot, while Postgres `=` is not.
  const baseHost = host?.split(":")[0].toLowerCase().replace(/\.$/, "")
  // localhost/127.0.0.1 skip the domain lookup, matching getTenantFromRequest:
  // no tenant registers a loopback domain, and this keeps the two resolvers
  // issuing the same queries as well as reaching the same answer.
  const isLoopback = baseHost === "localhost" || baseHost === "127.0.0.1"
  if (baseHost && !isLoopback) {
    const byDomain = await prisma.tenant.findFirst({
      where: { domain: baseHost, status: "ACTIVE" },
      select: { id: true },
    })
    if (byDomain) return byDomain.id
  }

  // 2. The slug the edge resolved from the host.
  if (slug) {
    const tenant = await prisma.tenant.findUnique({
      where: { slug },
      select: { id: true, status: true },
    })
    // ACTIVE-only, matching getTenantFromRequest: a suspended tenant must not
    // resolve just because its host still points here.
    if (tenant?.status === "ACTIVE") return tenant.id
    // A slug that named no ACTIVE tenant is a resolution FAILURE, not an
    // absent one. Falling through to the default here is precisely the
    // cross-tenant substitution this function exists to prevent: a suspended
    // tenant's staff would be shown the default tenant's data, and a save
    // would write to it. Fail loud instead — every deployed host is mapped, so
    // this only fires on a host nobody configured.
    throw new Error(
      `Tenant "${slug}" resolved from the request host is not an ACTIVE tenant`,
    )
  }

  return getDefaultTenantId()
})

/**
 * Higher-order wrapper for route handlers that need tenant ALS context.
 * Resolves tenant from request; on miss returns 400. On hit, runs the
 * handler body inside runWithTenant so any Prisma call to a tenant-scoped
 * model that omits where.tenantId is auto-injected; mismatched explicit
 * tenantId throws.
 *
 * Wrap routes that mutate tenant-scoped data via untrusted IDs.
 */
export async function withTenantContext<T>(
  req: NextRequest | Request,
  handler: (tenant: TenantContext) => Promise<T>
): Promise<T | Response> {
  // Every API route that resolves a tenant knows the lender's jurisdiction
  // (lib/jurisdiction) before its handler runs.
  await ensureActiveJurisdiction()
  const tenant = await getTenantFromRequest(req)
  if (!tenant) {
    const { NextResponse } = await import("next/server")
    return NextResponse.json({ error: "Tenant not found" }, { status: 400 })
  }
  // Bind every authenticated principal to its persisted tenant before the ALS
  // scope is entered. This is deliberately central: route-level role checks
  // establish authority, while this wrapper prevents a valid JWT from using a
  // caller-selected host/header to operate on another tenant.
  //
  // Keep auth lazy to avoid an eager module cycle during NextAuth
  // initialization. A missing persisted tenant is never inferred from the
  // request or the single-tenant default: an authenticated principal without
  // a tenant assignment fails closed.
  const { auth } = await import("./auth")
  const session = await auth()
  const { isOperatorRole } = await import("./operator/roles")
  if (session?.user && isOperatorRole(session.user.role)) {
    // An operator user holds no tenant: only this lender's active support
    // grant lets them in (lib/operator/tenant-access.ts, audited there).
    const { resolveOperatorTenantAccess } = await import("./operator/tenant-access")
    const { REQUEST_ID_HEADER } = await import("./proxy/operator-read-only")
    const access = await resolveOperatorTenantAccess({
      session: session.user, tenantId: tenant.id, resource: new URL(req.url).pathname,
      method: req.method, requestId: req.headers.get(REQUEST_ID_HEADER),
    })
    if (!access.allowed) {
      const { NextResponse } = await import("next/server")
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
  } else if (session?.user) {
    const principalTenantId = session.user.tenantId
    if (!principalTenantId || principalTenantId !== tenant.id) {
      const { NextResponse } = await import("next/server")
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }
  }
  return runWithTenant(tenant.id, () => handler(tenant))
}

export type TenantFeatureFlags = { featureCrm: boolean; featureIms: boolean; featureBureauSubmission: boolean; featureAssetFinance: boolean }

const ALL_FEATURES_OFF: TenantFeatureFlags = { featureCrm: false, featureIms: false, featureBureauSubmission: false, featureAssetFinance: false }

/**
 * Missing TenantConfig row (or missing flag column) resolves to OFF, not ON —
 * matches the sidebar's nav-hiding behaviour. Server-side gates on the
 * crm/contacts/insurance/compliance hubs must use this (not their own
 * `config?.featureX ?? true`) or a tenant with no config row would see the
 * module hidden from nav but still reachable by direct URL.
 *
 * Takes only the flag columns rather than a whole TenantConfigData, so a
 * caller that selects just what it screens on — `requireImsEnabled` reads the
 * live row uncached on every gated request — resolves through this same
 * function instead of hand-rolling `config?.featureX ?? false`.
 * `featureBureauSubmission` is optional for the same reason: the insurance gates
 * select only their two columns, and an unselected flag resolves OFF.
 */
export function resolveFeatureFlags(
  config: (Pick<TenantConfigData, "featureCrm" | "featureIms"> & Partial<Pick<TenantConfigData, "featureBureauSubmission" | "featureAssetFinance">>) | null,
): TenantFeatureFlags {
  return {
    featureCrm: config?.featureCrm ?? false,
    featureIms: config?.featureIms ?? false,
    featureBureauSubmission: config?.featureBureauSubmission ?? false,
    // Asset finance is an NCA product: off for every lender outside the NCA's
    // jurisdiction whatever the column says (lib/jurisdiction).
    featureAssetFinance: (config?.featureAssetFinance ?? false) && isNcaJurisdiction(),
  }
}

/**
 * Server-Component resolver for the nav-gated feature flags. Used by the
 * dashboard sidebar (AppShell), each gated section's layout.tsx, and the
 * dashboard layout itself — keep all call sites reading the same function so
 * they can't drift out of sync.
 *
 * Wrapped in React.cache like getResolvedTenantId above: within one render
 * tree the dashboard layout and a nested section layout both call this, so
 * caching dedupes it to a single tenant + config lookup per request.
 */
export const getTenantFeatures = cache(async (): Promise<TenantFeatureFlags> => {
  try {
    const headersList = await headers()
    const slug = headersList.get("x-tenant-slug") ?? process.env.NEXT_PUBLIC_TENANT_SLUG?.trim()
    if (!slug) return ALL_FEATURES_OFF
    const tenant = await getTenantBySlug(slug)
    if (!tenant) return ALL_FEATURES_OFF
    const config = await getTenantConfig(tenant.id)
    return resolveFeatureFlags(config)
  } catch {
    return ALL_FEATURES_OFF
  }
})
