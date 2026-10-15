import { NextRequest, NextResponse } from "next/server"
import { revalidateTag } from "next/cache"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AuditAction } from "@/lib/audit"
import { callerIp } from "@/lib/rate-limit"

// The backoffice switch for the IMS module. This is the ONLY thing it moves:
// `TenantConfig.featureIms`. It does not make any product sellable — that gate
// is `canSellProduct` in lib/insurance/product-readiness.ts and it stays shut
// until real insurer terms are captured.
//
// What the flag actually gates, stated exactly so no later reader widens it:
// `requireImsEnabled` covers app/api/insurance/** , and the (dashboard)/insurance
// and (dashboard)/compliance layouts redirect. It does NOT cover
// app/api/insurers/**, app/api/products/insurance/**, the portal's
// ppr-acknowledge route or app/api/cron/insurance-renewal — those keep serving
// with the flag off, because credit life reads insurer and
// insurance-product records and closing them would break it. That
// boundary is DELIBERATE. The sentence under the switch in
// components/settings/ImsModuleToggle.tsx says the same thing to the operator;
// the two must not drift.

// Schema default (prisma/schema/tenancy.prisma model TenantConfig). Used to hydrate the
// screen and to record the "old" audit value when no config row exists yet.
const DEFAULT_FEATURE_IMS = false

const SELECT = { featureIms: true } as const

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    try {
      const config = await prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: SELECT,
      })
      return NextResponse.json({ featureIms: config?.featureIms ?? DEFAULT_FEATURE_IMS })
    } catch (e) {
      console.error("Failed to load IMS module flag:", e)
      return NextResponse.json({ error: "Failed to load the IMS module flag" }, { status: 500 })
    }
  })
}

export async function PATCH(req: NextRequest) {
  const guard = await requireApiRole("ADMIN")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    let body: unknown
    try {
      body = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 })
    }

    const enabled = (body as { featureIms?: unknown } | null)?.featureIms
    if (typeof enabled !== "boolean") {
      return NextResponse.json({ error: "featureIms must be true or false." }, { status: 400 })
    }

    try {
      // Read-then-write in one transaction so the audited "old" value is exactly
      // the state this write replaced, even under concurrent edits.
      await prisma.$transaction(async (tx) => {
        const prev = await tx.tenantConfig.findUnique({
          where: { tenantId: tenant.id },
          select: SELECT,
        })
        await tx.tenantConfig.upsert({
          where: { tenantId: tenant.id },
          update: { featureIms: enabled },
          create: { tenantId: tenant.id, featureIms: enabled },
        })
        await tx.auditLog.create({
          data: {
            tenantId: tenant.id,
            action: enabled ? AuditAction.IMS_MODULE_ENABLED : AuditAction.IMS_MODULE_DISABLED,
            entity: "TenantConfig",
            entityId: tenant.id,
            userId: guard.user.id,
            userEmail: guard.user.email,
            oldValue: prev ?? { featureIms: DEFAULT_FEATURE_IMS },
            newValue: { featureIms: enabled },
            ipAddress: callerIp(req),
          },
        })
      })

      // The API gate (requireImsEnabled) reads the row uncached, so the API
      // surface closes the instant the transaction above commits. The staff NAV
      // and the page redirect in app/(dashboard)/insurance/layout.tsx do not —
      // they read getTenantConfig, which is wrapped in unstable_cache with
      // `revalidate: 300` under this tag. Without invalidation, switching the
      // module OFF would leave those pages reachable for up to five more
      // minutes while their APIs already 404.
      //
      // Deliberately in its OWN try: the flag is already committed by this
      // point, so a revalidation failure must not report the write as failed.
      // The worst case it degrades to is the stale-nav window that existed
      // before this call, which is not worth a 500 over a durable change.
      try {
        revalidateTag(`tenant-config-${tenant.id}`, "max")
      } catch (e) {
        console.error("IMS flag saved but tenant-config cache was not invalidated:", e)
      }

      return NextResponse.json({ ok: true, featureIms: enabled })
    } catch (e) {
      console.error("Failed to update IMS module flag:", e)
      return NextResponse.json({ error: "Failed to update the IMS module flag" }, { status: 500 })
    }
  })
}
