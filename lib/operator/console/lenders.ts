/**
 * What the operator console shows about its lenders: identity, status and
 * aggregate counts. No borrower row is ever read here — clients and loans are
 * counted (groupBy), never selected (the census, lib/operator/console-census.test.ts).
 */
import type { TenantStatus, UserRole } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { withoutTenantScope } from "@/lib/tenant-scope"
import { COLLECTIBLE_STATUSES } from "@/lib/loan/collectible-book"

export type LenderSummary = {
  id: string
  name: string
  slug: string
  domain: string | null
  status: TenantStatus
  createdAt: Date
  /** Loans on the book (the collectible book, lib/loan/collectible-book.ts). */
  activeLoans: number
  clients: number
  /** Last successful staff sign-in. */
  lastActivityAt: Date | null
}

const countOf = (rows: Array<{ tenantId: string; _count: { _all: number } }>) =>
  new Map(rows.map((r) => [r.tenantId, r._count._all]))

/** Every lender the operator runs, with aggregate counts. */
export async function listOperatorLenders(operatorId: string): Promise<LenderSummary[]> {
  const tenants = await prisma.tenant.findMany({
    where: { operatorId },
    select: { id: true, name: true, slug: true, domain: true, status: true, createdAt: true },
    orderBy: { name: "asc" },
  })
  if (tenants.length === 0) return []
  const counts = await lenderCounts(tenants.map((t) => t.id))
  return tenants.map((t) => ({
    ...t,
    activeLoans: counts.loans.get(t.id) ?? 0,
    clients: counts.clients.get(t.id) ?? 0,
    lastActivityAt: counts.lastSignIn.get(t.id) ?? null,
  }))
}

// Across the operator's lenders at once, so no tenant frame: an explicit
// tenantId list instead, which is all this may count.
async function lenderCounts(tenantIds: string[]) {
  const [loans, clients, signIns] = await withoutTenantScope(async () => await Promise.all([
    prisma.loan.groupBy({
      by: ["tenantId"],
      where: { tenantId: { in: tenantIds }, status: { in: [...COLLECTIBLE_STATUSES] } },
      _count: { _all: true },
    }),
    prisma.client.groupBy({ by: ["tenantId"], where: { tenantId: { in: tenantIds } }, _count: { _all: true } }),
    prisma.loginLog.groupBy({ by: ["tenantId"], where: { tenantId: { in: tenantIds }, success: true }, _max: { createdAt: true } }),
  ]))
  return {
    loans: countOf(loans),
    clients: countOf(clients),
    lastSignIn: new Map(signIns.map((r) => [r.tenantId, r._max.createdAt])),
  }
}

export type LenderAdmin = { id: string; name: string | null; email: string; role: UserRole; active: boolean; lastLoginAt: Date | null }

export type LenderDetail = LenderSummary & {
  brandName: string | null
  colours: { primaryColor: string; secondaryColor: string; darkColor: string } | null
  features: Record<string, boolean>
  admins: LenderAdmin[]
}

const FEATURE_SELECT = {
  featureLms: true, featureCrm: true, featureIms: true, featureBureauSubmission: true,
  featureMarketing: true, featurePortal: true, featureReports: true, featureAssetFinance: true,
} as const

/** One lender of this operator, or null. Lender staff (ADMIN and up) are listed for the admin reset. */
export async function getOperatorLender(operatorId: string, tenantId: string): Promise<LenderDetail | null> {
  const tenant = await prisma.tenant.findFirst({
    where: { id: tenantId, operatorId },
    select: {
      id: true, name: true, slug: true, domain: true, status: true, createdAt: true,
      // Branding and flags only: TenantConfig also holds sealed provider credentials.
      config: { select: { brandName: true, primaryColor: true, secondaryColor: true, darkColor: true, ...FEATURE_SELECT } },
    },
  })
  if (!tenant) return null
  const [counts, admins] = await Promise.all([
    lenderCounts([tenant.id]),
    prisma.user.findMany({
      where: { tenantId: tenant.id, role: { in: ["ADMIN", "SUPER_ADMIN"] } },
      select: { id: true, name: true, email: true, role: true, active: true, lastLoginAt: true },
      orderBy: [{ role: "desc" }, { email: "asc" }],
    }),
  ])
  const { config, ...rest } = tenant
  const features: Record<string, boolean> = {}
  for (const key of Object.keys(FEATURE_SELECT) as (keyof typeof FEATURE_SELECT)[]) features[key] = config?.[key] ?? false
  return {
    ...rest,
    activeLoans: counts.loans.get(tenant.id) ?? 0,
    clients: counts.clients.get(tenant.id) ?? 0,
    lastActivityAt: counts.lastSignIn.get(tenant.id) ?? null,
    brandName: config?.brandName ?? null,
    colours: config ? { primaryColor: config.primaryColor, secondaryColor: config.secondaryColor, darkColor: config.darkColor } : null,
    features,
    admins,
  }
}
