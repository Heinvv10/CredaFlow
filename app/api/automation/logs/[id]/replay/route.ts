import { NextResponse } from "next/server"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { AutomationReplayRefusedError, replayAutomationLog } from "@/lib/automation/engine"
import { logAudit } from "@/lib/audit"

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const guard = await requireApiRole("ADMIN")
    if (guard.error) return guard.error

    const { id } = await params

    // Awaited, so a refusal thrown inside is caught below.
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
    // Only the engine's own typed refusals carry their message to the client;
    // anything else is a server fault: logged, generic body.
    if (err instanceof AutomationReplayRefusedError) {
      return NextResponse.json({ error: err.message }, { status: err.code === "not_found" ? 404 : 422 })
    }
    console.error("Automation replay failed:", err)
    return NextResponse.json({ error: "Replay failed" }, { status: 500 })
  }
}
