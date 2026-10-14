import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({
  appFindFirst: vi.fn(),
  dealFindFirst: vi.fn(),
  relFindMany: vi.fn(),
  runScreening: vi.fn(),
  logAudit: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findFirst: (a: unknown) => h.appFindFirst(a) },
    assetFinanceDeal: { findFirst: (a: unknown) => h.dealFindFirst(a) },
    entityRelationship: { findMany: (a: unknown) => h.relFindMany(a) },
  },
}))
vi.mock("./run", () => ({ runScreening: (a: unknown) => h.runScreening(a) }))
vi.mock("@/lib/audit", () => ({
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
  logAudit: (a: unknown) => h.logAudit(a),
}))

import { screenOnSubmit } from "./on-submit"

const actor = { id: "u1", email: "u@test.invalid" }

beforeEach(() => {
  vi.clearAllMocks()
  h.runScreening.mockResolvedValue({ configured: true, runId: "r", state: { state: "CLEAR" }, providerError: null })
  h.relFindMany.mockResolvedValue([])
  h.logAudit.mockResolvedValue(undefined)
})

describe("screenOnSubmit", () => {
  it("screens a client application's client, triggered by the submitter", async () => {
    h.appFindFirst.mockResolvedValue({ clientId: "c1", entityId: null })
    await screenOnSubmit({ tenantId: "t1", applicationId: "a1", actor })
    expect(h.runScreening).toHaveBeenCalledTimes(1)
    expect(h.runScreening).toHaveBeenCalledWith({ tenantId: "t1", subject: { clientId: "c1" }, trigger: "APPLICATION_SUBMIT", applicationId: "a1", actor })
  })

  it("screens an entity application's entity and every active related party", async () => {
    h.appFindFirst.mockResolvedValue({ clientId: null, entityId: "e1" })
    h.relFindMany.mockResolvedValue([{ clientId: "d1" }, { clientId: "d2" }])
    await screenOnSubmit({ tenantId: "t1", applicationId: "a1", actor })
    expect(h.relFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { tenantId: "t1", entityId: "e1", active: true } }))
    expect(h.runScreening.mock.calls.map((c) => c[0].subject)).toEqual([{ entityId: "e1" }, { clientId: "d1" }, { clientId: "d2" }])
  })

  it("resolves an asset-finance deal to its application", async () => {
    h.dealFindFirst.mockResolvedValue({ applicationId: "a9" })
    h.appFindFirst.mockResolvedValue({ clientId: "c9", entityId: null })
    await screenOnSubmit({ tenantId: "t1", dealId: "deal-9", actor })
    expect(h.runScreening).toHaveBeenCalledWith(expect.objectContaining({ subject: { clientId: "c9" }, applicationId: "a9" }))
  })

  it("stops at once when screening is not configured", async () => {
    h.appFindFirst.mockResolvedValue({ clientId: null, entityId: "e1" })
    h.relFindMany.mockResolvedValue([{ clientId: "d1" }])
    h.runScreening.mockResolvedValue({ configured: false })
    await screenOnSubmit({ tenantId: "t1", applicationId: "a1", actor })
    expect(h.runScreening).toHaveBeenCalledTimes(1)
  })

  it("never rejects: a failure is audited instead", async () => {
    h.appFindFirst.mockResolvedValue({ clientId: "c1", entityId: null })
    h.runScreening.mockRejectedValue(new Error("db down"))
    await expect(screenOnSubmit({ tenantId: "t1", applicationId: "a1", actor })).resolves.toBeUndefined()
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({
      action: "SCREENING_RUN_FAILED", entity: "LoanApplication", entityId: "a1", newValue: expect.objectContaining({ error: "db down" }),
    }))
  })
})
