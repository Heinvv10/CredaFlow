import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const authMock = vi.fn()
const insightsMock = vi.fn()
const logAccessMock = vi.fn()

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/credit-checks/statement-insights", () => ({ applicationStatementInsights: (...a: unknown[]) => insightsMock(...a) }))
vi.mock("@/lib/document-auth", () => ({ logDocumentContentAccess: (a: unknown) => logAccessMock(a) }))

import { GET } from "./route"

const ctx = { params: Promise.resolve({ id: "app-1" }) }
const get = (headers: Record<string, string> = {}) => GET(new NextRequest("https://acme.example/api/applications/app-1/statement-insights", { headers }), ctx)
const session = (role: string) => ({ user: { id: "u1", email: "officer@test.invalid", role, tenantId: "t1" } })

beforeEach(() => {
  vi.resetAllMocks()
  authMock.mockResolvedValue(session("CREDIT_OFFICER"))
  insightsMock.mockResolvedValue({ insights: { coverageDays: 92, months: [] }, read: [{ documentId: "doc-1" }, { documentId: "doc-2" }], unread: 1 })
  logAccessMock.mockResolvedValue(undefined)
})

describe("GET /api/applications/[id]/statement-insights", () => {
  it("returns the figures for the tenant's application and logs every statement they summarise", async () => {
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ coverageDays: 92, months: [], unreadStatements: 1, modelLabelsEnabled: false })
    expect(insightsMock).toHaveBeenCalledWith("t1", "app-1")
    expect(logAccessMock).toHaveBeenCalledWith(expect.objectContaining({ documentIds: ["doc-1", "doc-2"], staffUserId: "u1", action: "statement_insights" }))
  })

  it("refuses READONLY staff", async () => {
    authMock.mockResolvedValue(session("READONLY"))
    expect((await get()).status).toBe(403)
    expect(insightsMock).not.toHaveBeenCalled()
  })

  it("is CREDIT_OFFICER and up: the role just below is refused, the one above allowed, no session is 401", async () => {
    authMock.mockResolvedValue(session("INSURANCE_OFFICER"))
    expect((await get()).status).toBe(403)
    authMock.mockResolvedValue(null)
    expect((await get()).status).toBe(401)
    expect(insightsMock).not.toHaveBeenCalled()
    authMock.mockResolvedValue(session("LOAN_ADMIN"))
    expect((await get()).status).toBe(200)
  })

  it("refuses a cross-site request", async () => {
    expect((await get({ "sec-fetch-site": "cross-site" })).status).toBe(403)
    expect(authMock).not.toHaveBeenCalled()
  })

  it("404s another tenant's application without logging", async () => {
    insightsMock.mockResolvedValue(null)
    expect((await get()).status).toBe(404)
    expect(logAccessMock).not.toHaveBeenCalled()
  })
})
