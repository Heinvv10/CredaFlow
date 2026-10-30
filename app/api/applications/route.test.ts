import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const prepareApplicationFieldsMock = vi.fn()
const queryRawMock = vi.fn()
const applicationCreateMock = vi.fn()
const applicationFindFirstMock = vi.fn()
const transactionMock = vi.fn()
const triggerNotificationMock = vi.fn()
const auditLogCreateMock = vi.fn()

const tx = {
  $queryRaw: (query: unknown) => queryRawMock(query),
  loanApplication: {
    create: (args: unknown) => applicationCreateMock(args),
  },
  auditLog: { create: (args: unknown) => auditLogCreateMock(args) },
}

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRoleMock(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (
    _req: unknown,
    cb: (tenant: { id: string }) => Promise<unknown>,
  ) => cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (cb: (client: typeof tx) => Promise<unknown>) => transactionMock(cb),
    loanApplication: {
      findFirst: (args: unknown) => applicationFindFirstMock(args),
    },
  },
}))
vi.mock("@/lib/applications/prepare-application", () => ({
  prepareApplicationFields: (...args: unknown[]) => prepareApplicationFieldsMock(...args),
}))
vi.mock("@/lib/utils", () => ({ generateReference: () => "APP-LOCKED" }))
vi.mock("@/lib/notifications", () => ({
  triggerNotification: (...args: unknown[]) => triggerNotificationMock(...args),
}))
const { screenOnSubmitMock } = vi.hoisted(() => ({ screenOnSubmitMock: vi.fn() }))
vi.mock("@/lib/screening/on-submit", () => ({ screenOnSubmit: (a: unknown) => screenOnSubmitMock(a) }))

import { POST } from "./route"

const input = {
  clientId: "client-1",
  productId: "product-1",
  appliedAmount: 500_000,
  appliedTermDays: 30,
  submitForReview: true,
}

const preparedFields = {
  ...input,
  purpose: null,
  loanPurposeCategory: null,
  agreementType: "SMALL",
  existingDebtObligations: [],
  totalExistingDebt: 0,
  netDisposableIncome: 700_000,
  affordabilityNDI: 500_000,
  affordabilityResult: { schemaVersion: 3, submission: { fingerprint: "locked" } },
  status: "SUBMITTED",
  submittedAt: new Date("2026-07-20T12:00:00.000Z"),
}

function request() {
  return new NextRequest("https://staging.acme-lending.example/api/applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
  })
}

describe("POST /api/applications", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    requireApiRoleMock.mockResolvedValue({
      user: { id: "officer-1", email: "officer@example.test" },
    })
    queryRawMock.mockResolvedValue([{ id: "locked" }])
    transactionMock.mockImplementation((cb: (client: typeof tx) => Promise<unknown>) => cb(tx))
    prepareApplicationFieldsMock.mockResolvedValue({ ok: true, fields: preparedFields })
    applicationCreateMock.mockResolvedValue({
      id: "application-1",
      reference: "APP-LOCKED",
      clientId: "client-1",
      productId: "product-1",
      status: "SUBMITTED",
    })
    auditLogCreateMock.mockResolvedValue({ id: "audit-1" })
    triggerNotificationMock.mockResolvedValue(undefined)
  })

  it("locks client and product evidence before preparing and creating", async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(requireApiRoleMock).toHaveBeenCalledWith("CREDIT_OFFICER")
    expect(queryRawMock).toHaveBeenCalledTimes(3)
    expect(prepareApplicationFieldsMock).toHaveBeenCalledWith(
      input,
      "tenant-1",
      "officer-1",
      { action: "create" },
      tx,
    )
    expect(queryRawMock.mock.invocationCallOrder[2]).toBeLessThan(
      prepareApplicationFieldsMock.mock.invocationCallOrder[0],
    )
    expect(prepareApplicationFieldsMock.mock.invocationCallOrder[0]).toBeLessThan(
      applicationCreateMock.mock.invocationCallOrder[0],
    )
    expect(applicationCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        reference: "APP-LOCKED",
        affordabilityResult: preparedFields.affordabilityResult,
        submittedAt: preparedFields.submittedAt,
        // Staff capture is recorded: an engine approval cannot be disbursed by whoever captured it.
        inputStaffIds: ["officer-1"],
      }),
    })
    expect(applicationCreateMock.mock.invocationCallOrder[0]).toBeLessThan(
      auditLogCreateMock.mock.invocationCallOrder[0],
    )
    expect(auditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        tenantId: "tenant-1",
        userId: "officer-1",
        action: "APPLICATION_SUBMITTED_BY_STAFF",
        entityId: "application-1",
      }),
    })
    // A6: PEP / sanctions screening is started once the submission committed.
    expect(screenOnSubmitMock).toHaveBeenCalledWith(expect.objectContaining({ tenantId: "tenant-1", applicationId: "application-1" }))
  })

  it("does not create when locked preparation fails", async () => {
    prepareApplicationFieldsMock.mockResolvedValueOnce({
      ok: false,
      status: 422,
      body: { error: "Client evidence changed" },
    })

    const response = await POST(request())

    expect(response.status).toBe(422)
    expect(applicationCreateMock).not.toHaveBeenCalled()
    expect(triggerNotificationMock).not.toHaveBeenCalled()
  })

  it("fails closed when the mandatory submission audit cannot be written", async () => {
    auditLogCreateMock.mockRejectedValueOnce(new Error("audit unavailable"))

    const response = await POST(request())

    expect(response.status).toBe(500)
    expect(applicationCreateMock).toHaveBeenCalledOnce()
    expect(auditLogCreateMock).toHaveBeenCalledOnce()
    expect(triggerNotificationMock).not.toHaveBeenCalled()
  })
})
