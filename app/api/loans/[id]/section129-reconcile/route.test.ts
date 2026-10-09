import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const loadReservationMock = vi.fn()
const finaliseMock = vi.fn()
const releaseMock = vi.fn()
const verifyIntegrityMock = vi.fn()
const logAuditStrictMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: unknown) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string }) => Promise<unknown>) => cb({ id: "t1" }),
}))
vi.mock("@/lib/audit", () => ({ logAuditStrict: (args: unknown) => logAuditStrictMock(args) }))
vi.mock("@/lib/collections/section129-artifact", () => ({
  Section129ArtifactIntegrityError: class Section129ArtifactIntegrityError extends Error {
    issuanceId: string
    expectedHash: string
    actualHash: string
    constructor(issuanceId: string, expectedHash: string, actualHash: string) {
      super("integrity failure")
      this.issuanceId = issuanceId
      this.expectedHash = expectedHash
      this.actualHash = actualHash
    }
  },
  Section129ArtifactUnavailableError: class Section129ArtifactUnavailableError extends Error {},
  Section129IssuanceConflictError: class Section129IssuanceConflictError extends Error {},
  loadSection129ReservationForReconciliation: (args: unknown) => loadReservationMock(args),
  finaliseSection129Issuance: (args: unknown) => finaliseMock(args),
  releaseSection129IssuanceAfterReconciliation: (args: unknown) => releaseMock(args),
  verifySection129ReservationIntegrity: (args: unknown) => verifyIntegrityMock(args),
}))

import { Section129ArtifactIntegrityError } from "@/lib/collections/section129-artifact"
import { POST } from "./route"

const ctx = { params: Promise.resolve({ id: "loan-1" }) }
const reservation = {
  issuanceId: "issue-1",
  idempotencyKey: "active-key",
  pdfSha256: "a".repeat(64),
  recordData: {
    reservedAt: "2026-07-19T03:55:00.000Z",
    dispatchStartedAt: "2026-07-19T03:59:00.000Z",
  },
}
const providerAcceptedAt = "2026-07-19T04:00:00.000Z"
function request(
  outcome: "ISSUED" | "NOT_SENT",
  reason = "Provider delivery log checked",
  acceptedAt: string | null | undefined = outcome === "ISSUED" ? providerAcceptedAt : undefined,
  emailMessageId: string | null | undefined = outcome === "ISSUED" ? "provider-1" : undefined,
) {
  return new NextRequest("http://x/api/loans/loan-1/section129-reconcile", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      issuanceId: "issue-1",
      outcome,
      reason,
      emailMessageId,
      providerAcceptedAt: acceptedAt,
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "admin-1", email: "admin@example.test" } })
  loadReservationMock.mockResolvedValue(reservation)
  finaliseMock.mockResolvedValue(undefined)
  releaseMock.mockResolvedValue(undefined)
  verifyIntegrityMock.mockResolvedValue(undefined)
  logAuditStrictMock.mockResolvedValue(undefined)
})

describe("POST Section 129 issuance reconciliation", () => {
  it("requires LOAN_ADMIN and finalises a provider-confirmed delivery", async () => {
    const response = await POST(request("ISSUED"), ctx)

    expect(response.status).toBe(200)
    expect(requireApiRoleMock).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(verifyIntegrityMock).toHaveBeenCalledWith(reservation)
    expect(finaliseMock).toHaveBeenCalledWith(expect.objectContaining({
      reservation,
      loanId: "loan-1",
      reconciliationReason: "Provider delivery log checked",
      issuedAt: new Date(providerAcceptedAt),
      emailMessageId: "provider-1",
    }))
    expect(releaseMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).not.toHaveBeenCalled()
  })

  it("requires and bounds the provider acceptance time for ISSUED reconciliation", async () => {
    const missing = await POST(request("ISSUED", "Provider log has no timestamp", null), ctx)
    expect(missing.status).toBe(422)
    expect(loadReservationMock).not.toHaveBeenCalled()

    const future = await POST(request("ISSUED", "Provider log checked carefully", "2999-01-01T00:00:00.000Z"), ctx)
    expect(future.status).toBe(422)
    expect(loadReservationMock).not.toHaveBeenCalled()

    const noTimezone = await POST(request("ISSUED", "Provider log checked carefully", "2026-07-19T04:00:00"), ctx)
    expect(noTimezone.status).toBe(422)
    expect(loadReservationMock).not.toHaveBeenCalled()

    const predatesDispatch = await POST(request("ISSUED", "Provider log checked carefully", "2026-07-19T03:00:00.000Z"), ctx)
    expect(predatesDispatch.status).toBe(422)
    expect(finaliseMock).not.toHaveBeenCalled()
  })

  it("requires a provider message or log reference before certifying ISSUED", async () => {
    const missing = await POST(request(
      "ISSUED",
      "Provider log checked carefully",
      providerAcceptedAt,
      null,
    ), ctx)
    expect(missing.status).toBe(422)
    expect(loadReservationMock).not.toHaveBeenCalled()

    const controlCharacters = await POST(request(
      "ISSUED",
      "Provider log checked carefully",
      providerAcceptedAt,
      "provider\nreference",
    ), ctx)
    expect(controlCharacters.status).toBe(422)
    expect(loadReservationMock).not.toHaveBeenCalled()
    expect(finaliseMock).not.toHaveBeenCalled()
  })

  it("releases only an administrator-confirmed NOT_SENT attempt", async () => {
    const response = await POST(request("NOT_SENT"), ctx)

    expect(response.status).toBe(200)
    expect(releaseMock).toHaveBeenCalledWith(expect.objectContaining({
      reservation,
      reconciledById: "admin-1",
    }))
    expect(finaliseMock).not.toHaveBeenCalled()
    expect(verifyIntegrityMock).not.toHaveBeenCalled()
  })

  it("fails closed and audits when the reserved artifact cannot be verified", async () => {
    verifyIntegrityMock.mockRejectedValue(
      new Section129ArtifactIntegrityError("issue-1", "a".repeat(64), "b".repeat(64)),
    )

    const response = await POST(request("ISSUED"), ctx)

    expect(response.status).toBe(409)
    expect(finaliseMock).not.toHaveBeenCalled()
    expect(logAuditStrictMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "SECTION_129_RECONCILIATION_INTEGRITY_FAILED",
      newValue: expect.objectContaining({ issuanceId: "issue-1" }),
    }))
  })

  it("keeps reconciliation blocked and returns 503 when the integrity incident cannot be audited", async () => {
    verifyIntegrityMock.mockRejectedValue(
      new Section129ArtifactIntegrityError("issue-1", "a".repeat(64), "b".repeat(64)),
    )
    logAuditStrictMock.mockRejectedValue(new Error("audit database unavailable"))

    const response = await POST(request("ISSUED"), ctx)
    const body = await response.json() as { auditRequired: boolean }

    expect(response.status).toBe(503)
    expect(body.auditRequired).toBe(true)
    expect(finaliseMock).not.toHaveBeenCalled()
  })

  it("rejects an undocumented reconciliation", async () => {
    const response = await POST(request("NOT_SENT", "short"), ctx)

    expect(response.status).toBe(422)
    expect(loadReservationMock).not.toHaveBeenCalled()
  })
})
