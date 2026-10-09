import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { isAssignableStaff } from "@/lib/crm/staff"
import { validateNewLeadTask, MANUAL_TASK_TYPE, LEAD_ENTITY_TYPE } from "@/lib/crm/lead-tasks"

export async function GET(req: NextRequest) {
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    const { searchParams } = new URL(req.url)
    const mine = searchParams.get("mine") === "1"
    const status = searchParams.get("status") ?? "PENDING"

    const tasks = await prisma.agentTask.findMany({
      where: {
        tenantId: tenant.id,
        status,
        ...(mine ? { assigneeId: guard.user.id } : {}),
      },
      include: { assignee: { select: { id: true, name: true, email: true } } },
      orderBy: [{ priority: "desc" }, { createdAt: "asc" }],
      take: 100,
    })

    return NextResponse.json(tasks)
  })
}

/**
 * Staff-created task.
 *
 * Creation was automation-only until now (lib/automation/actions.ts), so this
 * is the first path where a human supplies the fields — hence the validation
 * in lib/crm/lead-tasks.ts rather than trusting the form.
 *
 * Gated at CREDIT_OFFICER to match its siblings: PATCH /api/agent-tasks/[id]
 * and the reassignLead action both sit there, and a create bar below the
 * update bar would just be the same door with a lower lock.
 */
export async function POST(req: NextRequest) {
  const guard = await requireApiRole("CREDIT_OFFICER")
  if (guard.error) return guard.error

  return withTenantContext(req, async (tenant) => {
    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }
    const body = (raw ?? {}) as Record<string, unknown>

    // Lead-only by design. `entityType`/`entityId` are a free polymorphic pair
    // with no FK, so accepting an arbitrary type here would let a caller
    // attach a task to any row id — including another tenant's Client — with
    // nothing to validate it against. The panel is lead-only; when a Client
    // panel lands it adds its own branch AND its own existence check.
    if (body.entityType !== LEAD_ENTITY_TYPE) {
      return NextResponse.json({ error: "entityType must be \"Lead\"" }, { status: 400 })
    }
    if (typeof body.entityId !== "string" || !body.entityId) {
      return NextResponse.json({ error: "entityId is required" }, { status: 400 })
    }

    const parsed = validateNewLeadTask(body)
    if (!parsed.ok) return NextResponse.json({ error: parsed.error }, { status: 400 })
    const task = parsed.value

    // `Lead` is NOT in TENANT_SCOPED_MODELS (lib/tenant-scope.ts) — nothing
    // injects tenantId for us, so this filter is manual and load-bearing. It
    // is also the existence check: without it a task could be created against
    // another tenant's lead id and would then surface in their reminders.
    const lead = await prisma.lead.findFirst({
      where: { id: body.entityId, tenantId: tenant.id },
      select: { id: true },
    })
    if (!lead) return NextResponse.json({ error: "Lead not found" }, { status: 404 })

    // Same rule the owner picker uses. `User` is likewise absent from
    // TENANT_SCOPED_MODELS and `assigneeId` accepts any string, so an
    // unvalidated assignee could be another tenant's staff or a deactivated
    // account — which would then be the recipient of the reminder push.
    if (task.assigneeId) {
      const assignable = await isAssignableStaff(prisma.user, {
        tenantId: tenant.id,
        userId: task.assigneeId,
      })
      if (!assignable) return NextResponse.json({ error: "Invalid assignee" }, { status: 400 })
    }

    const created = await prisma.agentTask.create({
      data: {
        tenantId: tenant.id,
        type: MANUAL_TASK_TYPE,
        title: task.title,
        description: task.description ?? undefined,
        entityType: LEAD_ENTITY_TYPE,
        entityId: lead.id,
        priority: task.priority,
        dueAt: task.dueAt ?? undefined,
        assigneeId: task.assigneeId ?? undefined,
      },
      include: { assignee: { select: { id: true, name: true, email: true } } },
    })

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: AuditAction.AGENT_TASK_CREATED,
      entity: "AgentTask",
      entityId: created.id,
      newValue: {
        title: created.title,
        priority: created.priority,
        dueAt: created.dueAt,
        assigneeId: created.assigneeId,
        entityType: created.entityType,
        entityId: created.entityId,
      },
    })

    return NextResponse.json(created, { status: 201 })
  })
}
