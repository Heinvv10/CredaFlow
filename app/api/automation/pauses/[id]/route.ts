import { NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit } from "@/lib/audit"

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("ADMIN")
    if (guard.error) return guard.error

    const { id } = await params

    return withTenantContext(req, async (tenant) => {
      const deleted = await prisma.automationPause.deleteMany({
        where: { id, tenantId: tenant.id },
      })
      if (deleted.count === 0) return NextResponse.json({ error: "Pause not found" }, { status: 404 })

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "AUTOMATION_PAUSE_REMOVED",
        entity: "AutomationPause",
        entityId: id,
      })

      return NextResponse.json({ success: true })
    })
  } catch (err) {
    console.error("Failed to delete pause:", err)
    return NextResponse.json({ error: "Failed to delete pause" }, { status: 500 })
  }
}
