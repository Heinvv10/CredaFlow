// Covers POST /api/agent-tasks — the first human-facing task-create path.
// The guards here are the only thing standing between a form field and a row:
// AgentTask.entityType/entityId is a polymorphic pair with NO foreign key, and
// neither Lead nor User is in TENANT_SCOPED_MODELS, so every tenant filter is
// manual. If one of these checks goes missing nothing else catches it.
import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const {
  requireApiRoleMock,
  leadFindFirstMock,
  agentTaskCreateMock,
  isAssignableStaffMock,
  logAuditMock,
} = vi.hoisted(() => ({
  requireApiRoleMock: vi.fn(),
  leadFindFirstMock: vi.fn(),
  agentTaskCreateMock: vi.fn(),
  isAssignableStaffMock: vi.fn(),
  logAuditMock: vi.fn().mockResolvedValue(undefined),
}))

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (r: unknown) => requireApiRoleMock(r) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: { findFirst: (a: unknown) => leadFindFirstMock(a) },
    agentTask: { create: (a: unknown) => agentTaskCreateMock(a), findMany: vi.fn() },
    user: {},
  },
}))
vi.mock("@/lib/crm/staff", () => ({
  isAssignableStaff: (u: unknown, a: unknown) => isAssignableStaffMock(u, a),
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (a: unknown) => logAuditMock(a),
  // The route uses the registered constant, not a bare string — mock must carry
  // it or every call reads `undefined` and the audit assertion passes vacuously.
  AuditAction: { AGENT_TASK_CREATED: "AGENT_TASK_CREATED", AGENT_TASK_UPDATED: "AGENT_TASK_UPDATED" },
}))

const { POST } = await import("./route")

function post(body: unknown) {
  return new NextRequest("http://localhost/api/agent-tasks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

const VALID = { entityType: "Lead", entityId: "lead-1", title: "Call back about payslips" }

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.co.za" } })
  leadFindFirstMock.mockResolvedValue({ id: "lead-1" })
  isAssignableStaffMock.mockResolvedValue(true)
  agentTaskCreateMock.mockResolvedValue({
    id: "task-1", title: VALID.title, priority: "MEDIUM", dueAt: null,
    assigneeId: null, entityType: "Lead", entityId: "lead-1",
  })
})

describe("POST /api/agent-tasks — authz", () => {
  it("is gated at CREDIT_OFFICER, matching PATCH and reassignLead", async () => {
    await POST(post(VALID))
    expect(requireApiRoleMock).toHaveBeenCalledWith("CREDIT_OFFICER")
  })

  it("returns the guard's rejection without writing", async () => {
    const { NextResponse } = await import("next/server")
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })
    const res = await POST(post(VALID))
    expect(res.status).toBe(403)
    expect(agentTaskCreateMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/agent-tasks — the lead must be this tenant's", () => {
  it("looks the lead up filtered by tenantId, not by id alone", async () => {
    // Lead is absent from TENANT_SCOPED_MODELS: nothing injects this filter.
    await POST(post(VALID))
    expect(leadFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "lead-1", tenantId: "tenant-1" } })
    )
  })

  it("404s on another tenant's lead id instead of attaching a task to it", async () => {
    leadFindFirstMock.mockResolvedValue(null)
    const res = await POST(post({ ...VALID, entityId: "lead-in-tenant-2" }))
    expect(res.status).toBe(404)
    expect(agentTaskCreateMock).not.toHaveBeenCalled()
  })

  it("writes the tenantId it resolved, never one from the body", async () => {
    await POST(post({ ...VALID, tenantId: "tenant-999" }))
    expect(agentTaskCreateMock.mock.calls[0][0].data.tenantId).toBe("tenant-1")
  })
})

describe("POST /api/agent-tasks — entityType is restricted to Lead", () => {
  it("refuses a Client task — entityId would be validated against nothing", async () => {
    const res = await POST(post({ entityType: "Client", entityId: "client-1", title: "t" }))
    expect(res.status).toBe(400)
    expect(agentTaskCreateMock).not.toHaveBeenCalled()
  })

  it("refuses a missing entityType/entityId", async () => {
    expect((await POST(post({ title: "t" }))).status).toBe(400)
    expect((await POST(post({ entityType: "Lead", title: "t" }))).status).toBe(400)
    expect(agentTaskCreateMock).not.toHaveBeenCalled()
  })
})

describe("POST /api/agent-tasks — assignee", () => {
  it("checks the assignee against the same rule the owner picker uses", async () => {
    await POST(post({ ...VALID, assigneeId: "u2" }))
    expect(isAssignableStaffMock).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "tenant-1", userId: "u2" }
    )
  })

  it("400s on an assignee who is not active staff of this tenant", async () => {
    // Otherwise the reminder push would be addressed to them.
    isAssignableStaffMock.mockResolvedValue(false)
    const res = await POST(post({ ...VALID, assigneeId: "u-other-tenant" }))
    expect(res.status).toBe(400)
    expect(agentTaskCreateMock).not.toHaveBeenCalled()
  })

  it("does not run the assignee check when none is supplied", async () => {
    await POST(post(VALID))
    expect(isAssignableStaffMock).not.toHaveBeenCalled()
    expect(agentTaskCreateMock).toHaveBeenCalled()
  })
})

describe("POST /api/agent-tasks — validation + audit", () => {
  it("rejects an over-length title", async () => {
    const res = await POST(post({ ...VALID, title: "a".repeat(121) }))
    expect(res.status).toBe(400)
    expect(agentTaskCreateMock).not.toHaveBeenCalled()
  })

  it("rejects an unparseable due date rather than passing Invalid Date to prisma", async () => {
    const res = await POST(post({ ...VALID, dueAt: "banana" }))
    expect(res.status).toBe(400)
  })

  it("rejects malformed JSON with a 400, not a 500", async () => {
    const req = new NextRequest("http://localhost/api/agent-tasks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    })
    expect((await POST(req)).status).toBe(400)
  })

  it("audits the create — every state-changing action goes through lib/audit.ts", async () => {
    await POST(post(VALID))
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: "tenant-1",
        userId: "u1",
        action: "AGENT_TASK_CREATED",
        entity: "AgentTask",
        entityId: "task-1",
      })
    )
  })

  it("creates a staff task with type MANUAL, distinguishing it from automation rows", async () => {
    await POST(post(VALID))
    expect(agentTaskCreateMock.mock.calls[0][0].data).toMatchObject({
      type: "MANUAL",
      entityType: "Lead",
      entityId: "lead-1",
      priority: "MEDIUM",
    })
  })

  it("returns 201", async () => {
    expect((await POST(post(VALID))).status).toBe(201)
  })
})
