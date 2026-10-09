import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { Prisma } from "@prisma/client"

const authGuardMock = vi.fn()
const tenantContextMock = vi.fn()
const logAuditMock = vi.fn()
const agentFindFirst = vi.fn()
const codeFindUnique = vi.fn()
const codeCreate = vi.fn()
const generateUniqueMock = vi.fn()
const normaliseMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (...args: unknown[]) => authGuardMock(...args) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (tenant: unknown) => Promise<unknown>) => tenantContextMock(req, cb) }))
vi.mock("@/lib/audit", () => ({ logAudit: (...args: unknown[]) => logAuditMock(...args) }))
vi.mock("@/lib/referral-agents/referrals", () => ({
  generateUniqueReferralCode: (...args: unknown[]) => generateUniqueMock(...args),
  normaliseReferralCode: (value: unknown) => normaliseMock(value),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    referralAgent: { findFirst: (a: unknown) => agentFindFirst(a) },
    referralCode: {
      findUnique: (a: unknown) => codeFindUnique(a),
      create: (a: unknown) => codeCreate(a),
    },
  },
}))

import { POST } from "./route"

function req(body: object) {
  return new NextRequest("https://staging.acme-lending.example/api/agent-hub/referral-codes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/agent-hub/referral-codes", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    authGuardMock.mockResolvedValue({ user: { id: "user_1", email: "ops@example.com", role: "LOAN_ADMIN" } })
    tenantContextMock.mockImplementation((_req, cb) => cb({ id: "tenant_acme" }))
    agentFindFirst.mockResolvedValue({ id: "agent_1", displayName: "Field Agent" })
    codeFindUnique.mockResolvedValue(null)
    codeCreate.mockImplementation(async (args) => ({ id: "code_1", ...args.data }))
    generateUniqueMock.mockResolvedValue("ACMABC123")
    normaliseMock.mockImplementation((value) => (typeof value === "string" && value.trim() ? value.trim().toUpperCase() : null))
  })

  it("requires agentId before doing any code work", async () => {
    const res = await POST(req({ code: "ACMCUSTOM" }))
    const body = await res.json()
    expect(res.status).toBe(400)
    expect(body.error).toContain("agentId")
    expect(generateUniqueMock).not.toHaveBeenCalled()
    expect(agentFindFirst).not.toHaveBeenCalled()
    expect(codeCreate).not.toHaveBeenCalled()
  })

  it("404s when the agent is not found in this tenant", async () => {
    agentFindFirst.mockResolvedValue(null)
    const res = await POST(req({ agentId: "missing", code: "ACMCUSTOM" }))
    expect(res.status).toBe(404)
    expect(codeCreate).not.toHaveBeenCalled()
  })

  it("auto-generates a unique code when none is supplied, and audits the create", async () => {
    const res = await POST(req({ agentId: "agent_1" }))
    const body = await res.json()
    expect(res.status).toBe(201)
    expect(generateUniqueMock).toHaveBeenCalledWith(expect.anything(), "tenant_acme")
    expect(body.code).toBe("ACMABC123")
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "REFERRAL_CODE_CREATED", entityId: "code_1" }))
  })

  it("409s on a duplicate custom code (existence pre-check)", async () => {
    codeFindUnique.mockResolvedValue({ id: "existing" })
    const res = await POST(req({ agentId: "agent_1", code: "ACMCUSTOM" }))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error).toContain("already exists")
    expect(codeCreate).not.toHaveBeenCalled()
  })

  it("409s (not 500) when a concurrent create races the check and hits the unique constraint", async () => {
    codeCreate.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("Unique constraint failed", { code: "P2002", clientVersion: "test" }))
    const res = await POST(req({ agentId: "agent_1", code: "ACMCUSTOM" }))
    const body = await res.json()
    expect(res.status).toBe(409)
    expect(body.error).toContain("already exists")
  })
})
