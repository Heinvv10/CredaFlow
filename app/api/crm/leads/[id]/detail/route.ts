import { NextResponse } from "next/server"
import { requireApiRole, hasMinRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { getLeadDetailBundle } from "@/lib/crm/lead-detail-bundle"
import { agentDisplayName } from "@/lib/crm/lead-outreach-templates"

// The lead record bundle for the slide-over modal. READ-only: it assembles the
// same shape the full-page detail renders (via the shared getLeadDetailBundle),
// so opening the modal and opening the page can never disagree about the lead.
//
// Permissions are resolved from the SESSION here, not trusted from the client —
// the modal renders controls off them, but every mutation route re-checks its
// own gate. These flags only decide what to draw.
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error
  const role = guard.user.role

  // Three DIFFERENT bars, each mirroring the route it gates, all at
  // CREDIT_OFFICER today — kept separate so moving one doesn't silently move
  // the others (see the detail page for the same care).
  const canReassign = hasMinRole(role, "CREDIT_OFFICER")
  const canCreateTasks = hasMinRole(role, "CREDIT_OFFICER")
  const canManageTasks = hasMinRole(role, "CREDIT_OFFICER")

  return withTenantContext(req as never, async (tenant) => {
    try {
      const { id } = await params
      const bundle = await getLeadDetailBundle(id, tenant.id, canReassign)
      if (!bundle) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

      return NextResponse.json({
        ...bundle,
        permissions: { canReassign, canCreateTasks, canManageTasks },
        currentUserId: guard.user.id,
        // Same helper the send path uses, so the previewed signature matches
        // what actually goes out.
        agentName: agentDisplayName(guard.user.name),
      })
    } catch {
      return NextResponse.json({ error: "Failed to load lead" }, { status: 500 })
    }
  })
}
