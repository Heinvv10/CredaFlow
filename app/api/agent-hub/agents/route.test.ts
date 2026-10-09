import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextResponse } from "next/server"

const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const findManyAgentMock = vi.fn()
const countAgentMock = vi.fn()
const countReferralCodeMock = vi.fn()
const countReferralEventMock = vi.fn()
const countLeadMock = vi.fn()
const findManyReferralEventMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    referralAgent: { findMany: (a: unknown) => findManyAgentMock(a), count: (a: unknown) => countAgentMock(a) },
    referralCode: { count: (a: unknown) => countReferralCodeMock(a) },
    referralEvent: {
      count: (a: unknown) => countReferralEventMock(a),
      findMany: (a: unknown) => findManyReferralEventMock(a),
    },
    lead: { count: (a: unknown) => countLeadMock(a) },
  },
}))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) => withTenantContextMock(req, cb),
}))

import { GET } from "./route"

beforeEach(() => {
  vi.resetAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "staff@acme-lending.example", name: "Staff", role: "READONLY" } })
  withTenantContextMock.mockImplementation(async (_req, cb) => cb({ id: "tenant_acme" }))
  findManyAgentMock.mockResolvedValue([{ id: "agent_1", displayName: "Jane Doe", referralCodes: [], _count: { referralEvents: 2 } }])
  countAgentMock.mockResolvedValue(3)
  countReferralCodeMock.mockResolvedValue(4)
  countReferralEventMock.mockResolvedValue(10)
  countLeadMock.mockResolvedValue(6)
  findManyReferralEventMock.mockResolvedValue([
    {
      eventType: "WEBSITE_APPLICATION",
      source: "REFERRAL",
      amountCents: 100000,
      commissionStatus: "PENDING",
      qualityFlag: null,
      createdAt: new Date("2026-07-01T00:00:00.000Z"),
      code: { code: "AGENT01", label: "Rank agent" },
      agent: { displayName: "Jane Doe" },
    },
  ])
})

describe("GET /api/agent-hub/agents", () => {
  it("rejects unauthenticated/unauthorized callers via requireApiRole", async () => {
    requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })
    const res = await GET(new Request("https://staging.acme-lending.example/api/agent-hub/agents"))
    expect(res.status).toBe(401)
    expect(withTenantContextMock).not.toHaveBeenCalled()
  })

  it("authorized READONLY staff: returns agents + metrics + recentEvents", async () => {
    const res = await GET(new Request("https://staging.acme-lending.example/api/agent-hub/agents"))
    const body = await res.json()
    expect(res.status).toBe(200)
    expect(body.agents).toHaveLength(1)
    expect(body.metrics).toEqual({
      activeAgents: 3,
      activeReferralCodes: 4,
      totalReferralEvents: 10,
      websiteLeads: 6,
    })
    expect(body.recentEvents).toEqual([
      {
        eventType: "WEBSITE_APPLICATION",
        source: "REFERRAL",
        amount: 1000,
        commissionStatus: "PENDING",
        qualityFlag: null,
        createdAt: "2026-07-01T00:00:00.000Z",
        code: "AGENT01",
        codeLabel: "Rank agent",
        agentName: "Jane Doe",
      },
    ])
  })
})
