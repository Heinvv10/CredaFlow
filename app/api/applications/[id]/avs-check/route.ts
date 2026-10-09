import { NextRequest, NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { prisma } from "@/lib/prisma"
import { runAvsCheck } from "@/lib/avs"
import { CollectionProviderError } from "@/lib/integrations/collections/types"

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("CREDIT_OFFICER")
    if (guard.error) return guard.error

    // `return await` (not bare `return`) so a rejection inside the tenant
    // context is caught by the outer try/catch, matching the disburse route's
    // documented pattern (app/api/applications/[id]/disburse/route.ts).
    return await withTenantContext(req, async (tenant) => {
      const { id } = await params
      const application = await prisma.loanApplication.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true, clientId: true },
      })
      if (!application) {
        return NextResponse.json({ error: "Application not found" }, { status: 404 })
      }

      // Phase 7 AVS gate — dark behind TenantConfig.collectionsEngineEnabled.
      // Merge-day (flag-off) behavior must refuse before runAvsCheck ever runs.
      const tenantConfig = await prisma.tenantConfig.findUnique({
        where: { tenantId: tenant.id },
        select: { collectionsEngineEnabled: true },
      })
      if (!tenantConfig?.collectionsEngineEnabled) {
        return NextResponse.json(
          { error: "Collection engine is not enabled for this tenant" },
          { status: 409 }
        )
      }

      try {
        const result = await runAvsCheck({
          tenantId: tenant.id,
          clientId: application.clientId,
          applicationId: application.id,
          actor: { id: guard.user.id, email: guard.user.email },
        })
        return NextResponse.json(result)
      } catch (e) {
        if (e instanceof CollectionProviderError) {
          return NextResponse.json({ error: e.message }, { status: 409 })
        }
        return NextResponse.json(
          { error: e instanceof Error ? e.message : "AVS check failed" },
          { status: 400 }
        )
      }
    })
  } catch (error) {
    console.error("Failed to run AVS check:", error)
    return NextResponse.json({ error: "Failed to run AVS check" }, { status: 500 })
  }
}
