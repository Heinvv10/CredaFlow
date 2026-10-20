import { NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { replayAutomationLog } from "@/lib/automation/engine"
import { logAudit } from "@/lib/audit"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("ADMIN")
    if (guard.error) return guard.error

    const { id } = await params

    // Awaited, so a refusal thrown inside is caught below (422), not an unhandled 500.
    return await withTenantContext(req, async (tenant) => {
      const outcome = await replayAutomationLog(id, tenant.id)

      void logAudit({
        tenantId: tenant.id,
        userId: guard.user.id,
        userEmail: guard.user.email,
        action: "AUTOMATION_REPLAYED",
        entity: "AutomationLog",
        entityId: id,
        newValue: { result: outcome.result, error: outcome.error ?? null },
      })

      return NextResponse.json(outcome)
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error("Automation replay failed:", err)
    const isNotFound = msg.includes("not found")
    return NextResponse.json({ error: msg }, { status: isNotFound ? 404 : 422 })
  }
}
