import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { requireImsEnabled } from "@/lib/insurance/require-ims-enabled"
import { logAudit, AuditAction } from "@/lib/audit"

/**
 * Retire an ACTIVE rate table, leaving the product with no ACTIVE table at all
 * — which is the correct state for a product that must stop being sold. A
 * DRAFT is not retired (it is deleted), and an already-RETIRED table is
 * immutable, so both are 409.
 *
 * The write is an `updateMany` with `status: "ACTIVE"` repeated in the WHERE
 * clause and a `count` check, so a concurrent retire cannot re-stamp
 * `effectiveTo` and rewrite when cover actually stopped.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  try {
    const guard = await requireApiRole("INSURANCE_OFFICER")
    if (guard.error) return guard.error

    const { id } = await params

    return await withTenantContext(req, async (tenant) => {
      const blocked = await requireImsEnabled(tenant.id)
      if (blocked) return blocked

      const table = await prisma.insuranceRateTable.findFirst({
        where: { id, tenantId: tenant.id },
        select: { id: true, status: true, productId: true, version: true },
      })
      if (!table) return NextResponse.json({ error: "Not found" }, { status: 404 })

      if (table.status !== "ACTIVE") {
        return NextResponse.json(
          {
            error:
              table.status === "DRAFT"
                ? "A DRAFT rate table is deleted, not retired."
                : "This rate table is already retired.",
          },
          { status: 409 }
        )
      }

      const now = new Date()
      const retired = await prisma.insuranceRateTable.updateMany({
        where: { id, tenantId: tenant.id, status: "ACTIVE" },
        data: { status: "RETIRED", effectiveTo: now },
      })

      if (retired.count === 0) {
        return NextResponse.json(
          { error: "This rate table is no longer ACTIVE — it was retired concurrently." },
          { status: 409 }
        )
      }

      await logAudit({
        tenantId: tenant.id,
        userId: guard.user?.id,
        userEmail: guard.user?.email,
        action: AuditAction.INSURANCE_RATE_TABLE_RETIRED,
        entity: "InsuranceRateTable",
        entityId: id,
        oldValue: { status: "ACTIVE" },
        newValue: {
          status: "RETIRED",
          productId: table.productId,
          version: table.version,
          effectiveTo: now.toISOString(),
        },
      })

      return NextResponse.json({ ok: true, id, status: "RETIRED", effectiveTo: now })
    })
  } catch (error) {
    console.error("Failed to retire rate table:", error)
    return NextResponse.json({ error: "Failed to retire rate table" }, { status: 500 })
  }
}
