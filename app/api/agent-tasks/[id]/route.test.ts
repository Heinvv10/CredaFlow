// Covers PATCH /api/agent-tasks/[id] — specifically its per-row authz.
//
// The rule: THE ASSIGNMENT IS THE AUTHORISATION. A task's assignee may be any
// active staff member, so a flat CREDIT_OFFICER gate left anyone below the bar
// assignable, reminded by the cron, and refused by this route — nagged about
// work they could not action. Reassignment stays a management action.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  requireApiRoleMock,
  hasMinRoleMock,
  taskFindFirstMock,
  taskUpdateMock,
  crmActivityCreateMock,
  isAssignableStaffMock,
  logAuditMock,
} = vi.hoisted(() => ({
  requireApiRoleMock: vi.fn(),
  hasMinRoleMock: vi.fn(),
  taskFindFirstMock: vi.fn(),
  taskUpdateMock: vi.fn(),
  crmActivityCreateMock: vi.fn(),
  isAssignableStaffMock: vi.fn(),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (r: unknown) => requireApiRoleMock(r),
  hasMinRole: (a: unknown, b: unknown) => hasMinRoleMock(a, b),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    agentTask: { findFirst: (a: unknown) => taskFindFirstMock(a), update: (a: unknown) => taskUpdateMock(a) },
    crmActivity: { create: (a: unknown) => crmActivityCreateMock(a) },
    user: {},
  },
}))
vi.mock("@/lib/crm/staff", () => ({
  isAssignableStaff: (u: unknown, a: unknown) => isAssignableStaffMock(u, a),
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  AuditAction: { AGENT_TASK_UPDATED: "AGENT_TASK_UPDATED" },
}))

const { PATCH } = await import("./route")

const params = Promise.resolve({ id: "task-1" })
function patch(body: unknown) {
  return new NextRequest("http://localhost/api/agent-tasks/task-1", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

/** Task assigned to `agent` (a sub-bar user). */
const TASK = { id: "task-1", status: "PENDING", assigneeId: "agent", title: "Call back", description: null, entityType: "Lead", entityId: "lead-1" }

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "agent", email: "a@n.co.za", role: "COLLECTIONS_AGENT" } })
  hasMinRoleMock.mockReturnValue(false) // sub-bar by default
  taskFindFirstMock.mockResolvedValue(TASK)
  taskUpdateMock.mockResolvedValue({ ...TASK, status: "COMPLETED" })
  crmActivityCreateMock.mockResolvedValue({ id: "act-1" })
  isAssignableStaffMock.mockResolvedValue(true)
})

describe("the route admits any staff, then decides per row", () => {
  it("does not gate the route itself at CREDIT_OFFICER", async () => {
    // A flat bar here is what created the nag: the assignee could not reach
    // their own task.
    await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(requireApiRoleMock).toHaveBeenCalledWith("READONLY")
  })

  it("still refuses an unauthenticated caller", async () => {
    const { NextResponse } = await import("next/server")
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    const res = await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(res.status).toBe(401)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })
})

describe("the assignment is the authorisation", () => {
  it("lets a SUB-BAR assignee complete their OWN task", async () => {
    // The whole point: a collections agent occasionally works a lead. Assign
    // them, they do it, they tick it off.
    const res = await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(res.status).toBe(200)
    expect(taskUpdateMock).toHaveBeenCalledTimes(1)
    expect(taskUpdateMock.mock.calls[0][0].data.status).toBe("COMPLETED")
  })

  it("refuses a sub-bar caller on SOMEONE ELSE's task", async () => {
    requireApiRoleMock.mockResolvedValue({ user: { id: "someone-else", email: "x@n.co.za", role: "COLLECTIONS_AGENT" } })
    const res = await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(res.status).toBe(403)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses a sub-bar caller on an UNASSIGNED task — nobody owns it", async () => {
    taskFindFirstMock.mockResolvedValue({ ...TASK, assigneeId: null })
    const res = await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(res.status).toBe(403)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  // The falsy cases are what the truthiness check actually buys. `=== null`
  // alone already rejects `null === "agent"`, so a null-vs-real-id test proves
  // nothing about the guard — it passes with the guard deleted. These pin the
  // pair that `===` alone would happily match.
  it("refuses an empty-string assignee matching an empty-string caller id", async () => {
    requireApiRoleMock.mockResolvedValue({ user: { id: "", email: "x@n.co.za", role: "COLLECTIONS_AGENT" } })
    taskFindFirstMock.mockResolvedValue({ ...TASK, assigneeId: "" })
    const res = await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(res.status).toBe(403)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses a caller with no id at all on an unassigned task", async () => {
    requireApiRoleMock.mockResolvedValue({ user: { id: undefined, email: "x@n.co.za", role: "COLLECTIONS_AGENT" } })
    taskFindFirstMock.mockResolvedValue({ ...TASK, assigneeId: undefined })
    const res = await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(res.status).toBe(403)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  it("lets a manager complete anyone's task", async () => {
    hasMinRoleMock.mockReturnValue(true)
    requireApiRoleMock.mockResolvedValue({ user: { id: "officer", email: "o@n.co.za", role: "CREDIT_OFFICER" } })
    const res = await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(res.status).toBe(200)
  })

  it("checks the bar against CREDIT_OFFICER", async () => {
    await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(hasMinRoleMock).toHaveBeenCalledWith("COLLECTIONS_AGENT", "CREDIT_OFFICER")
  })
})

describe("reassignment stays a management action", () => {
  it("refuses an assignee reassigning their OWN task away", async () => {
    // Otherwise the per-row gate becomes a way to push your work onto anyone:
    // the route let you in because the task is yours.
    const res = await PATCH(patch({ assigneeId: "someone-else" }), { params })
    expect(res.status).toBe(403)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses an assignee UNassigning their own task", async () => {
    const res = await PATCH(patch({ assigneeId: null }), { params })
    expect(res.status).toBe(403)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses a sub-bar assignee smuggling a reassign alongside a legitimate status change", async () => {
    const res = await PATCH(patch({ status: "COMPLETED", assigneeId: "someone-else" }), { params })
    expect(res.status).toBe(403)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  it("allows a manager to reassign", async () => {
    hasMinRoleMock.mockReturnValue(true)
    requireApiRoleMock.mockResolvedValue({ user: { id: "officer", email: "o@n.co.za", role: "CREDIT_OFFICER" } })
    const res = await PATCH(patch({ assigneeId: "u2" }), { params })
    expect(res.status).toBe(200)
    expect(isAssignableStaffMock).toHaveBeenCalledWith(expect.anything(), { tenantId: "tenant-1", userId: "u2" })
  })
})

describe("tenant scoping + existing guards still hold", () => {
  it("looks the task up scoped to the tenant", async () => {
    await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(taskFindFirstMock).toHaveBeenCalledWith({ where: { id: "task-1", tenantId: "tenant-1" } })
  })

  it("404s on another tenant's task", async () => {
    taskFindFirstMock.mockResolvedValue(null)
    const res = await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(res.status).toBe(404)
  })

  it("rejects an invalid status", async () => {
    hasMinRoleMock.mockReturnValue(true)
    const res = await PATCH(patch({ status: "DONE" }), { params })
    expect(res.status).toBe(400)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  it("rejects a non-string assigneeId instead of silently unassigning", async () => {
    hasMinRoleMock.mockReturnValue(true)
    requireApiRoleMock.mockResolvedValue({ user: { id: "officer", email: "o@n.co.za", role: "CREDIT_OFFICER" } })
    const res = await PATCH(patch({ assigneeId: 42 }), { params })
    expect(res.status).toBe(400)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  it("400s on an assignee who is not active staff of this tenant", async () => {
    hasMinRoleMock.mockReturnValue(true)
    requireApiRoleMock.mockResolvedValue({ user: { id: "officer", email: "o@n.co.za", role: "CREDIT_OFFICER" } })
    isAssignableStaffMock.mockResolvedValue(false)
    const res = await PATCH(patch({ assigneeId: "foreign" }), { params })
    expect(res.status).toBe(400)
  })

  it("audits the STATUS from the written row, not the request body", async () => {
    // Contrived on purpose: the mock returns a row whose status differs from
    // what was asked for, which the real DB would not do. That divergence is
    // the ONLY way to prove WHICH source the audit reads — while the two agree,
    // `body.status ?? task.status` and `updated.status` are indistinguishable
    // and the assertion passes either way. It did: this exact mutation survived
    // the last round, because fixing the assigneeId half left the status half
    // asserted against a value derived from the same source the code reads.
    hasMinRoleMock.mockReturnValue(true)
    requireApiRoleMock.mockResolvedValue({ user: { id: "officer", email: "o@n.co.za", role: "CREDIT_OFFICER" } })
    taskUpdateMock.mockResolvedValue({ ...TASK, status: "CANCELLED" })
    await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: expect.objectContaining({ status: "CANCELLED" }) })
    )
  })

  it("scopes the update itself to the tenant, not only the lookup", async () => {
    // Defence in depth: the findFirst above already 404s a cross-tenant id, so
    // this cannot be reached today. It costs one predicate to not depend on
    // that ordering surviving a future refactor.
    await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(taskUpdateMock.mock.calls[0][0].where).toEqual({ id: "task-1", tenantId: "tenant-1" })
  })

  it("audits the update from the WRITTEN row, not the request body", async () => {
    // Asserted on the UNASSIGN case specifically. On a plain complete, the
    // fixture's assigneeId and the written row's are the same value, so the
    // assertion cannot tell which source the code read — it passes with the
    // very regression this names (`body.assigneeId ?? task.assigneeId`, where
    // `null ?? "agent"` yields the OLD assignee and the audit row then states
    // the opposite of what happened). Clearing the assignee is the one case
    // where written and requested genuinely differ.
    hasMinRoleMock.mockReturnValue(true)
    requireApiRoleMock.mockResolvedValue({ user: { id: "officer", email: "o@n.co.za", role: "CREDIT_OFFICER" } })
    taskUpdateMock.mockResolvedValue({ ...TASK, assigneeId: null })
    await PATCH(patch({ assigneeId: null }), { params })
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "AGENT_TASK_UPDATED",
        entityId: "task-1",
        oldValue: { status: "PENDING", assigneeId: "agent" },
        newValue: { status: "PENDING", assigneeId: null },
      })
    )
  })
})

// The rule is "your own task is yours to CLOSE", not "to set to anything".
// The ownership gate otherwise hands a sub-bar assignee the whole status enum.
describe("an assignee may close their task — not cancel or re-open it", () => {
  it("refuses CANCELLED from a sub-bar assignee", async () => {
    // CANCELLED leaves OPEN_TASK_STATUSES, so the task silently drops out of
    // the reminder cron AND the lead panel, and the CrmActivity write is
    // COMPLETED-only — work assigned by a manager would vanish from the queue
    // with only an audit row to show for it.
    const res = await PATCH(patch({ status: "CANCELLED" }), { params })
    expect(res.status).toBe(403)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses a re-open (COMPLETED -> PENDING) from a sub-bar assignee", async () => {
    // completedAt/completedById are only ever set, never cleared, so a re-open
    // leaves a PENDING row claiming a completion it no longer has — and
    // re-arms the cron.
    taskFindFirstMock.mockResolvedValue({ ...TASK, status: "COMPLETED" })
    const res = await PATCH(patch({ status: "PENDING" }), { params })
    expect(res.status).toBe(403)
    expect(taskUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses IN_PROGRESS from a sub-bar assignee — only closing is authorised", async () => {
    const res = await PATCH(patch({ status: "IN_PROGRESS" }), { params })
    expect(res.status).toBe(403)
  })

  it("still lets a MANAGER cancel or re-open", async () => {
    hasMinRoleMock.mockReturnValue(true)
    requireApiRoleMock.mockResolvedValue({ user: { id: "officer", email: "o@n.co.za", role: "CREDIT_OFFICER" } })
    expect((await PATCH(patch({ status: "CANCELLED" }), { params })).status).toBe(200)
    expect((await PATCH(patch({ status: "PENDING" }), { params })).status).toBe(200)
  })
})

// `completedById` is the "who did this work" field at a lender. It records the
// FIRST close, and nothing in the codebase ever clears it — the F1 restriction
// above leans on that, so it is pinned here rather than assumed.
describe("the completion stamp", () => {
  it("records who closed the task, and when", async () => {
    await PATCH(patch({ status: "COMPLETED" }), { params })
    const data = taskUpdateMock.mock.calls[0][0].data
    expect(data.completedById).toBe("agent")
    expect(data.completedAt).toBeInstanceOf(Date)
  })

  it("is NOT re-stamped on an already-completed task", async () => {
    // {status:"COMPLETED"} on a closed task clears every guard — it is your
    // task, and COMPLETED is the status the assignment authorises — so without
    // the task.status check an assignee could retroactively claim a completion
    // a manager recorded and walk completedAt forward at will.
    taskFindFirstMock.mockResolvedValue({ ...TASK, status: "COMPLETED" })
    await PATCH(patch({ status: "COMPLETED" }), { params })
    const data = taskUpdateMock.mock.calls[0][0].data
    expect(data.completedById).toBeUndefined()
    expect(data.completedAt).toBeUndefined()
  })

  it("is not written when the status is not changing to COMPLETED", async () => {
    hasMinRoleMock.mockReturnValue(true)
    requireApiRoleMock.mockResolvedValue({ user: { id: "officer", email: "o@n.co.za", role: "CREDIT_OFFICER" } })
    await PATCH(patch({ status: "CANCELLED" }), { params })
    expect(taskUpdateMock.mock.calls[0][0].data.completedById).toBeUndefined()
  })
})

// The F1 reasoning cites this dedup explicitly as why a re-open is dangerous.
// Reasoning the code depends on deserves a test of its own.
describe("the lead timeline note", () => {
  it("is written on a first completion", async () => {
    await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(crmActivityCreateMock).toHaveBeenCalledTimes(1)
    expect(crmActivityCreateMock.mock.calls[0][0].data).toMatchObject({
      tenantId: "tenant-1",
      leadId: "lead-1",
      subject: "Task completed: Call back",
    })
  })

  it("is NOT written again when an already-completed task is re-completed", async () => {
    // Otherwise cycling a task writes a fresh "Task completed" NOTE per pass
    // and the lead's timeline fills with duplicates.
    taskFindFirstMock.mockResolvedValue({ ...TASK, status: "COMPLETED" })
    await PATCH(patch({ status: "COMPLETED" }), { params })
    expect(crmActivityCreateMock).not.toHaveBeenCalled()
  })
})

describe("body handling", () => {
  it("400s on malformed JSON rather than 500ing — the sibling POST already does", async () => {
    const req = new NextRequest("http://localhost/api/agent-tasks/task-1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    })
    expect((await PATCH(req, { params })).status).toBe(400)
  })

  it("400s on an empty body instead of writing a no-op update + audit row", async () => {
    const res = await PATCH(patch({}), { params })
    expect(res.status).toBe(400)
    expect(taskUpdateMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })
})
