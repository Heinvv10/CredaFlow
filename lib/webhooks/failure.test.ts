import { describe, it, expect, vi, beforeEach } from "vitest"

const prismaCreate = vi.fn()
const auditMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    webhookSignatureFailure: { create: (args: unknown) => prismaCreate(args) },
  },
}))
vi.mock("@/lib/audit", () => ({
  logAudit: (args: unknown) => auditMock(args),
}))

import { writeWebhookSignatureFailure } from "./failure"

describe("writeWebhookSignatureFailure", () => {
  beforeEach(() => {
    prismaCreate.mockReset()
    auditMock.mockReset()
    prismaCreate.mockResolvedValue({ id: "wsf_test_1" })
  })

  it("persists provider + reason + body sha256 (NOT the body itself)", async () => {
    const rawBody = '{"event":"delivered"}'
    await writeWebhookSignatureFailure({
      provider: "BULKSMS",
      reason: "BAD_HMAC",
      pathname: "/api/webhooks/bulksms",
      rawBody,
      rawHeaders: { "x-bulksms-hmac": "deadbeef" },
      sourceIp: "203.0.113.42",
      tenantId: null,
    })
    expect(prismaCreate).toHaveBeenCalledTimes(1)
    const call = prismaCreate.mock.calls[0][0]
    expect(call.data.provider).toBe("BULKSMS")
    expect(call.data.reason).toBe("BAD_HMAC")
    expect(call.data.pathname).toBe("/api/webhooks/bulksms")
    expect(call.data.sourceIp).toBe("203.0.113.42")
    expect(call.data.tenantId).toBeNull()
    expect(call.data.rawBodySha256).toMatch(/^[a-f0-9]{64}$/)
    expect(call.data.rawHeaders).toEqual({ "x-bulksms-hmac": "deadbeef" })
    // Body itself MUST NOT be persisted — verify the create payload doesn't contain it
    expect(JSON.stringify(call.data)).not.toContain("delivered")
  })

  it("emits a WEBHOOK_SIGNATURE_FAILED audit with the persisted row id", async () => {
    await writeWebhookSignatureFailure({
      provider: "META_WA",
      reason: "MISSING_HEADER",
      pathname: "/api/webhooks/whatsapp",
      rawBody: "",
      rawHeaders: {},
      sourceIp: null,
      tenantId: null,
    })
    expect(auditMock).toHaveBeenCalledTimes(1)
    const call = auditMock.mock.calls[0][0]
    expect(call.action).toBe("WEBHOOK_SIGNATURE_FAILED")
    expect(call.entity).toBe("WebhookSignatureFailure")
    expect(call.entityId).toBe("wsf_test_1")
    expect(call.tenantId).toBeUndefined() // audit tenantId omitted when row is unscoped
    expect(call.newValue).toMatchObject({ provider: "META_WA", reason: "MISSING_HEADER" })
  })

  it("carries tenantId through to BOTH the row and the audit when provided", async () => {
    await writeWebhookSignatureFailure({
      provider: "TWILIO",
      reason: "BAD_HMAC",
      pathname: "/api/webhooks/twilio",
      rawBody: "Body=STOP",
      rawHeaders: { "x-twilio-signature": "abc" },
      sourceIp: "198.51.100.1",
      tenantId: "tenant_abc",
    })
    expect(prismaCreate.mock.calls[0][0].data.tenantId).toBe("tenant_abc")
    expect(auditMock.mock.calls[0][0].tenantId).toBe("tenant_abc")
  })

  it("returns the persisted row id", async () => {
    const result = await writeWebhookSignatureFailure({
      provider: "WA_UNOFFICIAL",
      reason: "BAD_HMAC",
      pathname: "/api/webhooks/wa-unofficial",
      rawBody: "",
      rawHeaders: {},
      sourceIp: null,
      tenantId: null,
    })
    expect(result.id).toBe("wsf_test_1")
  })
})
