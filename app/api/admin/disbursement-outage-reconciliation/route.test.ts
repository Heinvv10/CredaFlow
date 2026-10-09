import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const {
  guardMock,
  tenantContextMock,
  reconcileMock,
} = vi.hoisted(() => ({
  guardMock: vi.fn(),
  tenantContextMock: vi.fn(),
  reconcileMock: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (role: string) => guardMock(role),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    request: NextRequest,
    callback: (tenant: { id: string }) => Promise<Response>,
  ) => tenantContextMock(request, callback),
}))
vi.mock("@/lib/disbursement/outage-reconciliation", () => ({
  reconcileOutageDisbursements: (args: unknown) => reconcileMock(args),
}))

import { POST } from "./route"

/**
 * The outage allow-list is intentionally EMPTY in this product, so no incidentId
 * is known and the route refuses every request at its incident check. The
 * incident id below is synthetic.
 */
const INCIDENT_ID = "test-incident-0001"

const validBody = {
  incidentId: INCIDENT_ID,
  managementApprovalNote:
    "Test Approver approved the formal outage reconciliation.",
}

function request(body: unknown = validBody) {
  return new NextRequest(
    "https://app.acme-lending.example/api/admin/disbursement-outage-reconciliation",
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  )
}

describe("POST /api/admin/disbursement-outage-reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    guardMock.mockResolvedValue({
      user: {
        id: "super-admin-1",
        email: "operator@example.test",
        role: "SUPER_ADMIN",
        tenantId: "tenant-1",
      },
    })
    tenantContextMock.mockImplementation((
      _request: NextRequest,
      callback: (tenant: { id: string }) => Promise<Response>,
    ) => callback({ id: "tenant-1" }))
  })

  it("returns the guard's 401 without entering tenant context", async () => {
    guardMock.mockResolvedValue({
      error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }),
    })

    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(tenantContextMock).not.toHaveBeenCalled()
  })

  it("returns the guard's 403 for a role below SUPER_ADMIN", async () => {
    guardMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })

    const response = await POST(request())

    expect(response.status).toBe(403)
    expect(guardMock).toHaveBeenCalledWith("SUPER_ADMIN")
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it("rejects malformed JSON and a short management note", async () => {
    const malformed = new NextRequest(
      "https://app.acme-lending.example/api/admin/disbursement-outage-reconciliation",
      { method: "POST", body: "{" },
    )
    expect((await POST(malformed)).status).toBe(400)
    expect((await POST(request({
      managementApprovalNote: "too short",
    }))).status).toBe(400)
    expect(reconcileMock).not.toHaveBeenCalled()
  })

  it.each([
    ["a dry-run", {}],
    ["an apply with a wrong confirmation", { apply: true, confirmation: "yes" }],
    [
      "an apply with the derived confirmation",
      {
        apply: true,
        confirmation: `RECONCILE-${INCIDENT_ID.toUpperCase()}`,
      },
    ],
    ["a missing incidentId", { incidentId: undefined }],
    ["an inherited key as incidentId", { incidentId: "constructor" }],
  ])("refuses %s with 400: no incident is known", async (_label, change) => {
    const response = await POST(request({ ...validBody, ...change }))

    expect(response.status).toBe(400)
    expect(await response.json()).toEqual({
      error: "A known outage incidentId is required",
    })
    expect(tenantContextMock).not.toHaveBeenCalled()
    expect(reconcileMock).not.toHaveBeenCalled()
  })
})
