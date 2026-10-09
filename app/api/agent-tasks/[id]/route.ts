import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { requireApiRole, hasMinRole } from "@/lib/auth-guards"
import { withTenantContext } from "@/lib/tenant"
import { logAudit, AuditAction } from "@/lib/audit"
import { isTaskStatus } from "@/lib/crm/lead-tasks"
import { isAssignableStaff } from "@/lib/crm/staff"

/**
 * Update a task.
 *
 * Gated per-row rather than by role alone, because a task's assignee may be any
 * active staff member (lib/crm/staff.ts — owning and working a lead is not
 * restricted by seniority). A flat CREDIT_OFFICER gate meant anyone below it
 * could be assigned a task and reminded about it by the cron, while this route
 * refused their update and the panel rendered the control inert: nagged about
 * work they could not action. Nobody chose that; the two rules were simply
 * written independently.
 *
 * The rule that fixes it without deciding who may be assigned: THE ASSIGNMENT
 * IS THE AUTHORISATION. If a task is yours, you may close it. Reassigning it
 * stays a management action — otherwise an assignee could hand their own work
 * to anyone.
 *
 * Deliberately NOT fixed by restricting who may be assigned: lead follow-up is
 * mostly credit work, but not exclusively (confirmed with the business), and a
 * hard floor would make the legitimate exception impossible with no way around
 * it.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  // Any staff member may reach the route; what they may CHANGE is decided
  // per-field below, once we know whose task this is.
  const guard = await requireApiRole("READONLY")
  if (guard.error) return guard.error

  const { id } = await params

  return withTenantContext(req, async (tenant) => {
    const task = await prisma.agentTask.findFirst({ where: { id, tenantId: tenant.id } })
    if (!task) {
      return NextResponse.json({ error: "Not found" }, { status: 404 })
    }

    const canManage = hasMinRole(guard.user.role, "CREDIT_OFFICER")
    // Truthiness on assigneeId, not `!== null`. `=== null` looks sufficient —
    // `null === "agent"` is already false — but it leaves an empty-string
    // assigneeId matching an empty-string caller id. Both are normalised away
    // today, which is precisely why this must not depend on that staying true.
    // No matching guard on `guard.user.id`: if assigneeId is truthy AND equal
    // to it, the caller id is truthy by implication, so the clause would be
    // unreachable — and an unreachable guard is one nobody can test and
    // everybody trusts.
    const isOwnTask = !!task.assigneeId && task.assigneeId === guard.user.id

    if (!canManage && !isOwnTask) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    let raw: unknown
    try {
      raw = await req.json()
    } catch {
      // The sibling POST already answers 400 here; a 500 for a malformed body
      // is the route blaming itself for the caller's mistake.
      return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
    }
    const body = (raw ?? {}) as { status?: string; assigneeId?: unknown }

    if (body.status === undefined && body.assigneeId === undefined) {
      // An empty body wrote a no-op update plus an audit row whose oldValue
      // equalled its newValue. Harmless, but it is audit noise that this PR
      // makes reachable by every staff member rather than only managers.
      return NextResponse.json({ error: "Nothing to update" }, { status: 400 })
    }

    // Reassignment is a management action. Without this, an assignee below the
    // bar could push their own task onto someone else — the route's gate would
    // have let them in on the strength of it being theirs.
    if (body.assigneeId !== undefined && !canManage) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // One status list, shared with POST and the reminder cron
    // (lib/crm/lead-tasks.ts) — a status accepted by one write path must not
    // be rejected by another.
    if (body.status !== undefined && !isTaskStatus(body.status)) {
      return NextResponse.json({ error: "Invalid status" }, { status: 400 })
    }

    // The rule is "your own task is yours to CLOSE" — not "to set to anything".
    // Without this the ownership gate hands a sub-bar assignee the whole status
    // enum, and two of those values are worse than the nag this PR fixes:
    //   CANCELLED — not in OPEN_TASK_STATUSES, so the task silently leaves both
    //     the reminder cron and the lead panel. The CrmActivity write below is
    //     COMPLETED-only, so nothing appears on the timeline either: work
    //     assigned by a manager disappears from the queue, at a lender, with
    //     only an audit row to show for it.
    //   PENDING (re-open) — completedAt/completedById are only ever set, never
    //     cleared, so the row would claim a completion it no longer has, re-arm
    //     the cron, and write a fresh "Task completed" NOTE on every cycle
    //     (the dedup guard below is `task.status !== "COMPLETED"`).
    // A manager may still do all of it; this only bounds what the ASSIGNMENT
    // itself authorises.
    if (body.status !== undefined && !canManage && body.status !== "COMPLETED") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Same rule POST applies. `AgentTask.assignee` does have an FK to User, but
    // nothing constrains it to THIS tenant and `User` is absent from
    // TENANT_SCOPED_MODELS, so an unvalidated id here lands another tenant's
    // staff — whose name and email then render wherever this task is listed
    // (both the GET on the sibling route and the lead detail panel `include`
    // the assignee). Validating on create but not on update would leave the
    // same door with a lower lock.
    //
    // null / "" means "unassign", which stays allowed — only an actual id is
    // checked. Normalising "" to null also stops an empty string being stored
    // as a live assignee that matches no user.
    //
    // Anything else that is not a string is rejected rather than coerced: a
    // body of {"assigneeId": 42} silently UNASSIGNING the task is a wrong
    // write dressed up as a success.
    let assigneeUpdate: { assigneeId: string | null } | undefined
    if (body.assigneeId !== undefined) {
      const raw = body.assigneeId
      if (raw !== null && typeof raw !== "string") {
        return NextResponse.json({ error: "Invalid assignee" }, { status: 400 })
      }
      const next = typeof raw === "string" && raw !== "" ? raw : null
      if (next) {
        const assignable = await isAssignableStaff(prisma.user, {
          tenantId: tenant.id,
          userId: next,
        })
        if (!assignable) return NextResponse.json({ error: "Invalid assignee" }, { status: 400 })
      }
      assigneeUpdate = { assigneeId: next }
    }

    // The completion stamp records who FIRST closed the task, so it is written
    // only on the PENDING/IN_PROGRESS -> COMPLETED transition. Keyed off
    // task.status, mirroring the CrmActivity dedup below, because
    // `{status:"COMPLETED"}` on an ALREADY-completed task clears every guard
    // above (it is your task, and COMPLETED is the one status the assignment
    // authorises) and would otherwise re-stamp it. `completedById` is the "who
    // did this work" field at a lender: without this, any assignee could
    // retroactively claim a completion a manager recorded and walk completedAt
    // forward indefinitely. Not reachable from the panel — it only lists open
    // tasks — but the API is reachable by any staff member.
    const isFirstCompletion = body.status === "COMPLETED" && task.status !== "COMPLETED"

    const updated = await prisma.agentTask.update({
      where: { id, tenantId: tenant.id },
      data: {
        ...(body.status ? { status: body.status } : {}),
        ...(assigneeUpdate ?? {}),
        ...(isFirstCompletion ? { completedAt: new Date(), completedById: guard.user.id } : {}),
      },
    })

    await logAudit({
      tenantId: tenant.id,
      userId: guard.user.id,
      userEmail: guard.user.email,
      action: AuditAction.AGENT_TASK_UPDATED,
      entity: "AgentTask",
      entityId: id,
      oldValue: { status: task.status, assigneeId: task.assigneeId },
      // Read back from the written row, not re-derived from the request body.
      // `body.assigneeId ?? task.assigneeId` reported the OLD assignee whenever
      // the caller cleared it (null ?? old → old) — an audit row that states the
      // opposite of what happened is worse than none.
      newValue: { status: updated.status, assigneeId: updated.assigneeId },
    })

    // Log CrmActivity when task is completed
    if (body.status === "COMPLETED" && task.status !== "COMPLETED") {
      const leadId = task.entityType === "Lead" ? task.entityId : null
      const clientId = task.entityType === "Client" ? task.entityId : null
      if (leadId || clientId) {
        await prisma.crmActivity.create({
          data: {
            tenantId: tenant.id,
            leadId,
            clientId,
            type: "NOTE",
            subject: `Task completed: ${task.title}`,
            notes: task.description ?? undefined,
            completedAt: new Date(),
            createdById: guard.user.id,
          },
        }).catch((err: unknown) => {
          console.error("[agent-tasks] Failed to log CrmActivity for task completion:", err)
        })
      }
    }

    return NextResponse.json(updated)
  })
}
