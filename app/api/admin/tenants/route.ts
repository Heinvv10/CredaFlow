import { NextRequest, NextResponse } from "next/server"
import { auth } from "@/lib/auth"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAuditStrict } from "@/lib/audit"
import { redactTenantCredentials } from "@/lib/integrations/tenant-credentials"
import { DEFAULT_TENANT_COLOURS, tenantColourErrors } from "@/lib/theme/tenant-colours"
import { instanceJurisdictionMessage, isInstanceJurisdictionError } from "@/lib/jurisdiction/instance.server"
import { normaliseTenantDomain, tenantDomainRefusal, tenantSlugRefusal } from "@/lib/config/tenant-domain"
import type { Session } from "next-auth"

function isAuthorized(req: NextRequest, session: Session | null): boolean {
  if (session?.user?.role !== "SUPER_ADMIN") return false
  const adminSecret = req.headers.get("x-admin-secret")
  const envSecret = process.env.ADMIN_SECRET
  if (!envSecret) return false
  return adminSecret === envSecret
}

export async function GET(req: NextRequest) {
  const session = await auth()
  if (!isAuthorized(req, session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const tenants = await prisma.tenant.findMany({
    include: { config: true },
    orderBy: { createdAt: "asc" },
  })

  // A whole TenantConfig row leaves only with every credential masked and the
  // sealed bureau credentials redacted, sealed or not.
  return NextResponse.json(tenants.map(redactTenantCredentials))
}

export async function POST(req: NextRequest) {
  const session = await auth()
  if (!isAuthorized(req, session)) {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  let body: {
    slug: string
    name: string
    domain?: string
    primaryColor?: string
    secondaryColor?: string
    darkColor?: string
  }

  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  if (!body.slug || !body.name) {
    return NextResponse.json({ error: "slug and name are required" }, { status: 400 })
  }

  const colours = {
    primaryColor: body.primaryColor ?? DEFAULT_TENANT_COLOURS.primaryColor,
    secondaryColor: body.secondaryColor ?? DEFAULT_TENANT_COLOURS.secondaryColor,
    darkColor: body.darkColor ?? DEFAULT_TENANT_COLOURS.darkColor,
  }
  const colourErrors = tenantColourErrors(colours)
  if (Object.keys(colourErrors).length > 0) {
    return NextResponse.json({ error: "Tenant colours fail validation", fields: colourErrors }, { status: 422 })
  }

  // Normalised, and never a host the deployment or another lender serves
  // (lib/config/tenant-domain.ts).
  const domain = normaliseTenantDomain(body.domain)
  if (!domain.ok) return NextResponse.json({ error: domain.error }, { status: 422 })
  const domainRefusal = domain.domain ? await tenantDomainRefusal(domain.domain, null) : null
  if (domainRefusal) return NextResponse.json({ error: domainRefusal }, { status: 422 })
  const slugRefusal = await tenantSlugRefusal(body.slug)
  if (slugRefusal) return NextResponse.json({ error: slugRefusal }, { status: 422 })

  const existing = await prisma.tenant.findUnique({ where: { slug: body.slug } })
  if (existing) {
    return NextResponse.json({ error: "Tenant slug already exists" }, { status: 409 })
  }

  // The tenant and its audit row commit together, or neither does.
  // A new lender's config takes the instance's jurisdiction (database trigger); a refusal
  // (a legacy mismatch) is a 409, not a 500.
  const tenant = await prisma.$transaction(async (tx) => {
    const created = await tx.tenant.create({
      data: {
        slug: body.slug,
        name: body.name,
        domain: domain.domain,
        status: "PROVISIONING",
        config: { create: colours },
      },
      include: { config: true },
    })
    await logAuditStrict({
      tenantId: created.id,
      userId: session?.user?.id,
      userEmail: session?.user?.email ?? undefined,
      action: AuditAction.TENANT_CREATED,
      entity: "Tenant",
      entityId: created.id,
      newValue: { slug: created.slug, name: created.name, domain: created.domain, status: created.status, ...colours },
    }, tx)
    return created
  }).catch((e: unknown) => (isInstanceJurisdictionError(e) ? e : Promise.reject(e)))
  if (tenant instanceof Error) return NextResponse.json({ error: instanceJurisdictionMessage(tenant) }, { status: 409 })

  return NextResponse.json(redactTenantCredentials(tenant), { status: 201 })
}
