import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const requireApiRole = vi.fn()
const reconcileHeldMessage = vi.fn()

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...args: unknown[]) => requireApiRole(...args),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, callback: (tenant: { id: string }) => Promise<unknown>) =>
    callback({ id: "tenant-1" }),
}))
vi.mock("@/lib/messaging/reconcile-held-message", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/messaging/reconcile-held-message")>()),
  reconcileHeldMessage: (...args: unknown[]) => reconcileHeldMessage(...args),
}))

import {
  MessageReconciliationConflictError,
  MessageReconciliationEvidenceError,
} from "@/lib/messaging/reconcile-held-message"
import { POST } from "./route"

const context = { params: Promise.resolve({ id: "message-1" }) }

function request(body: unknown) {
  return new NextRequest("https://staging.acme-lending.example/api/messaging/reconciliation/message-1", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

describe("POST /api/messaging/reconciliation/[id]", () => {
  beforeEach(() => {
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-07-22T15:00:00.000Z"))
    requireApiRole.mockResolvedValue({
      user: { id: "admin-1", email: "admin@example.test" },
    })
    reconcileHeldMessage.mockResolvedValue(undefined)
  })

  it("requires LOAN_ADMIN before reading the body", async () => {
    requireApiRole.mockResolvedValue({ error: new Response("forbidden", { status: 403 }) })
    const response = await POST(request({ outcome: "NOT_SENT", reason: "Provider checked" }), context)
    expect(response.status).toBe(403)
    expect(requireApiRole).toHaveBeenCalledWith("LOAN_ADMIN")
    expect(reconcileHeldMessage).not.toHaveBeenCalled()
  })

  it("records a provider-accepted outcome with exact evidence", async () => {
    const response = await POST(request({
      outcome: "SENT",
      reason: "BulkSMS delivery log checked",
      evidenceReference: "bulk-case-123",
      providerMessageId: "bulk-message-123",
      providerAcceptedAt: "2026-07-22T14:00:00+02:00",
    }), context)

    expect(response.status).toBe(200)
    expect(reconcileHeldMessage).toHaveBeenCalledWith({
      tenantId: "tenant-1",
      messageId: "message-1",
      outcome: "SENT",
      reason: "BulkSMS delivery log checked",
      evidenceReference: "bulk-case-123",
      providerMessageId: "bulk-message-123",
      providerAcceptedAt: new Date("2026-07-22T12:00:00.000Z"),
      userId: "admin-1",
      userEmail: "admin@example.test",
    })
  })

  it.each([
    [{ outcome: "UNKNOWN", reason: "Provider checked" }, /outcome/],
    [{ outcome: "NOT_SENT", reason: "short" }, /reason/],
    [{ outcome: "SENT", reason: "Provider checked", providerAcceptedAt: "2026-07-22T14:00:00Z" }, /evidenceReference/],
    [{ outcome: "SIMULATED", reason: "Dry-run logs checked", evidenceReference: "x" }, /evidenceReference/],
    [{ outcome: "SENT", reason: "Provider checked", evidenceReference: "bulk-case-123", providerMessageId: "bulk-message-123", providerAcceptedAt: "2026-07-22 14:00" }, /providerAcceptedAt/],
    [{ outcome: "SENT", reason: "Provider checked", evidenceReference: "bulk-case-123", providerMessageId: "bulk-message-123", providerAcceptedAt: "2026-07-22T16:00:00Z" }, /future/],
    [{ outcome: "NOT_SENT", reason: "Provider checked", evidenceReference: "bulk-case-123", providerMessageId: "contradictory-id" }, /providerMessageId/],
    [{ outcome: "NOT_SENT", reason: "Provider checked", evidenceReference: "bulk-case-123", providerAcceptedAt: "2026-07-22T14:00:00Z" }, /providerAcceptedAt/],
    [{ outcome: "SIMULATED", reason: "Dry run checked", evidenceReference: "bulk-case-123", providerAcceptedAt: "2026-07-22T14:00:00Z" }, /providerAcceptedAt/],
    [{ outcome: "NOT_SENT", reason: "Provider checked", evidenceReference: "bulk-case-123", simulationReceiptId: "dry-run-1" }, /simulationReceiptId/],
  ])("rejects invalid reconciliation evidence %#", async (body, message) => {
    const response = await POST(request(body), context)
    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(message)
    expect(reconcileHeldMessage).not.toHaveBeenCalled()
  })

  it("passes an explicit local receipt for a manually verified simulation", async () => {
    const response = await POST(request({
      outcome: "SIMULATED",
      reason: "Dry-run service log checked",
      evidenceReference: "dry-run-case-123",
      simulationReceiptId: "dry-run-receipt-123",
    }), context)

    expect(response.status).toBe(200)
    expect(reconcileHeldMessage).toHaveBeenCalledWith(expect.objectContaining({
      outcome: "SIMULATED",
      simulationReceiptId: "dry-run-receipt-123",
    }))
  })

  it("returns 409 when another operator already resolved the hold", async () => {
    reconcileHeldMessage.mockRejectedValue(new MessageReconciliationConflictError())
    const response = await POST(request({
      outcome: "NOT_SENT",
      reason: "Provider logs show no request",
      evidenceReference: "provider-case-not-sent",
    }), context)
    expect(response.status).toBe(409)
  })

  it("returns 422 when the requested outcome contradicts durable provider evidence", async () => {
    reconcileHeldMessage.mockRejectedValue(new MessageReconciliationEvidenceError(
      "A durable ACCEPTED provider outcome cannot be reconciled as NOT_SENT",
    ))
    const response = await POST(request({
      outcome: "NOT_SENT",
      reason: "Provider logs were checked by operations",
      evidenceReference: "provider-case-not-sent",
    }), context)

    expect(response.status).toBe(422)
    expect((await response.json()).error).toMatch(/durable ACCEPTED/)
  })
})
