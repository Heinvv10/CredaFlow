import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest, NextResponse } from "next/server"

const requireApiRoleMock = vi.fn()
const clientFindUniqueMock = vi.fn()
const loadRetroAttributionPlanMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) =>
    cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: { client: { findUnique: (...args: unknown[]) => clientFindUniqueMock(...args) } },
}))
vi.mock("@/lib/referral-agents/retro-attribution-apply", () => ({
  loadRetroAttributionPlan: (...args: unknown[]) => loadRetroAttributionPlanMock(...args),
}))

import { GET } from "./route"

const context = { params: Promise.resolve({ id: "client-1" }) }

function getRequest(query = "?codeId=code-b") {
  return new NextRequest(`http://localhost/api/clients/client-1/referral-impact${query}`)
}

function accrual(over: Record<string, unknown> = {}) {
  return {
    loanId: "L1", loanReference: "LN-0001", loanStatus: "ACTIVE", loanCreatedAt: "2026-06-01",
    principalCents: 100_000, clientId: "client-1", clientName: "Thandi Nkosi",
    clientPhone: null, clientEmail: null, agentName: "Agent Two",
    agentPhone: null, agentEmail: null, agentStatus: "ACTIVE", agentCommissionBps: null,
    codeValue: "CODE-B", codeStatus: "ACTIVE", bps: 100, commissionCents: 1_000,
    ...over,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({
    user: { id: "staff-1", email: "admin@example.test", role: "LOAN_ADMIN" },
  })
  clientFindUniqueMock.mockResolvedValue({ referralCodeId: "code-a" })
  loadRetroAttributionPlanMock.mockResolvedValue({
    accrue: [accrual(), accrual({ loanId: "L2", loanReference: "LN-0002", principalCents: 200_000, commissionCents: 2_000 })],
    reverse: [{ eventId: "evt-a1", loanId: "L1", loanReference: "LN-0001", agentName: "Outgoing Agent", commissionCents: 900 }],
    skipped: [{ ...accrual({ loanId: "L3", loanReference: "LN-0003" }), reason: "CLAWED_BACK" }],
    blockers: [],
  })
})

describe("GET /api/clients/[id]/referral-impact", () => {
  // Previewing what a re-attribution would pay is the same class of act as
  // making it — it discloses another agent's commission — so it carries the
  // same floor the write does (lib/clients/referral-update.ts).
  it("guards on the referral reassignment floor", async () => {
    await GET(getRequest(), context)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
  })

  it("returns the guard's refusal without touching the plan", async () => {
    requireApiRoleMock.mockResolvedValue({
      error: NextResponse.json({ error: "Forbidden" }, { status: 403 }),
    })
    const res = await GET(getRequest(), context)
    expect(res.status).toBe(403)
    expect(loadRetroAttributionPlanMock).not.toHaveBeenCalled()
  })

  it("404s an unknown client in this tenant", async () => {
    clientFindUniqueMock.mockResolvedValue(null)
    const res = await GET(getRequest(), context)
    expect(res.status).toBe(404)
    expect(loadRetroAttributionPlanMock).not.toHaveBeenCalled()
  })

  // The preview must be computed against the code ACTUALLY on file, not one the
  // caller asserts, or a stale form previews a reversal that will not happen.
  it("plans from the stored previous code and the requested one", async () => {
    await GET(getRequest("?codeId=code-b"), context)
    expect(loadRetroAttributionPlanMock).toHaveBeenCalledWith(expect.anything(), {
      tenantId: "tenant-1",
      clientId: "client-1",
      incomingCodeId: "code-b",
      previousCodeId: "code-a",
    })
  })

  it("treats an absent or blank codeId as clearing the agent", async () => {
    await GET(getRequest(""), context)
    expect(loadRetroAttributionPlanMock.mock.calls[0][1]).toMatchObject({ incomingCodeId: null })
  })

  it("returns the same plan the PUT would apply, totalled", async () => {
    const res = await GET(getRequest(), context)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      accrue: [
        { loanReference: "LN-0001", principalCents: 100_000, commissionCents: 1_000 },
        { loanReference: "LN-0002", principalCents: 200_000, commissionCents: 2_000 },
      ],
      reverse: [{ loanReference: "LN-0001", agentName: "Outgoing Agent", commissionCents: 900 }],
      skipped: [{ loanReference: "LN-0003", reason: "CLAWED_BACK" }],
      blockers: [],
      totalAccrueCents: 3_000,
      totalReverseCents: 900,
      // Zero unknowns here; the total is a complete figure and says so.
      reverseUnknownCount: 0,
    })
  })

  // NEW-3. commissionCents is Int?. The preview must not let a total that
  // cannot account for every row read as though it did.
  it("says how many reversal amounts the total cannot account for", async () => {
    loadRetroAttributionPlanMock.mockResolvedValue({
      accrue: [], skipped: [], blockers: [],
      reverse: [
        { eventId: "e1", loanId: "L1", loanReference: "LN-0001", agentName: "Outgoing Agent", commissionCents: 900, metadata: {} },
        { eventId: "e2", loanId: "L2", loanReference: "LN-0002", agentName: "Outgoing Agent", commissionCents: null, metadata: {} },
      ],
    })

    const body = await (await GET(getRequest(), context)).json()
    expect(body.totalReverseCents).toBe(900)
    expect(body.reverseUnknownCount).toBe(1)
    expect(body.reverse[1].commissionCents).toBeNull()
  })

  it("surfaces a blocker so the form can refuse the save", async () => {
    loadRetroAttributionPlanMock.mockResolvedValue({
      accrue: [], reverse: [], skipped: [],
      blockers: [{ kind: "PAID_ROW_EXISTS", loanReference: "LN-0001", agentName: "Outgoing Agent" }],
    })
    const res = await GET(getRequest(), context)
    const body = await res.json()
    expect(body.blockers).toEqual([
      { kind: "PAID_ROW_EXISTS", loanReference: "LN-0001", agentName: "Outgoing Agent" },
    ])
  })
})
