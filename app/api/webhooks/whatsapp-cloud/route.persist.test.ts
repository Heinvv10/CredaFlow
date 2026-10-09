import { afterEach, describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const tenantFindUnique = vi.fn()
const commsSettingsFindUnique = vi.fn()
const commsSettingsFindFirst = vi.fn()
const transactionMock = vi.fn()
const contactLookupMock = vi.fn()
const verifyMock = vi.fn()
const handleWaStopMock = vi.fn()
const routeInboundMock = vi.fn()
const logAuditMock = vi.fn()
const getCommsSettingsMock = vi.fn()
const applyTemplateStatusMock = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: (a: unknown) => tenantFindUnique(a) },
    commsSettings: {
      findUnique: (a: unknown) => commsSettingsFindUnique(a),
      findFirst: (a: unknown) => commsSettingsFindFirst(a),
    },
    $transaction: (cb: unknown) => transactionMock(cb),
  },
}))
vi.mock("@/lib/contact/identity", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, lookupContactByChannelValue: (...a: unknown[]) => contactLookupMock(...a) }
})
vi.mock("@/lib/webhooks", () => ({
  verifyWaba: (...a: unknown[]) => verifyMock(...a),
  writeWebhookSignatureFailure: vi.fn(),
}))
vi.mock("@/lib/messaging/wa-stop", () => ({
  handleWaStopInbound: (...a: unknown[]) => handleWaStopMock(...a),
  STOP_REGEX: /^STOP\b/i,
}))
vi.mock("@/lib/inbox/routing", () => ({ routeInbound: (...a: unknown[]) => routeInboundMock(...a) }))
vi.mock("@/lib/audit", () => ({ logAudit: (...a: unknown[]) => logAuditMock(...a) }))
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: (...a: unknown[]) => getCommsSettingsMock(...a) }))
vi.mock("@/lib/whatsapp/template-status", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, applyWabaTemplateStatuses: (...a: unknown[]) => applyTemplateStatusMock(...a) }
})
vi.mock("@/lib/tenant-scope", async (orig) => {
  const real = (await orig()) as Record<string, unknown>
  return { ...real, runWithTenant: (_t: string, fn: () => unknown) => fn() }
})

import { POST } from "./route"

function req(text: string): NextRequest {
  return new NextRequest("https://app.acme-lending.example/api/webhooks/whatsapp-cloud", {
    method: "POST",
    headers: { "x-hub-signature-256": "sha256=x" },
    body: JSON.stringify({
      entry: [{ changes: [{ value: {
        metadata: { phone_number_id: "PN-OWNER" },
        messages: [{ id: "wamid.HBgL_x", from: "27821234567", type: "text", text: { body: text } }],
      } }] }],
    }),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv("WHATSAPP_CLOUD_APP_SECRET", "sek")
  commsSettingsFindUnique.mockResolvedValue({ tenantId: "tn1" })
  commsSettingsFindFirst.mockResolvedValue({ tenantId: "tn1" })
  tenantFindUnique.mockResolvedValue({ id: "tn1", slug: "acme" })
  verifyMock.mockReturnValue({ ok: true })
  getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: true })
  transactionMock.mockImplementation(async (cb: (tx: unknown) => unknown) => cb({}))
})

// Without this the stubbed secret leaks into every later file in this worker.
afterEach(() => { vi.unstubAllEnvs() })

describe("POST /api/webhooks/whatsapp-cloud — provider labelling", () => {
  it("passes WA_CLOUD to the known-contact path", async () => {
    contactLookupMock.mockResolvedValue({ id: "ct1", tenantId: "tn1" })
    handleWaStopMock.mockResolvedValue({ messageId: "m1", conversationId: "cv1", consentRevokedId: null })

    const res = await POST(req("hello"))
    expect(res.status).toBe(200)
    expect(handleWaStopMock.mock.calls[0][1]).toMatchObject({ provider: "WA_CLOUD" })
  })

  it("passes WA_CLOUD to the unknown-contact path", async () => {
    contactLookupMock.mockResolvedValue(null)
    routeInboundMock.mockResolvedValue({ handled: true, persisted: true, messageId: "m1", conversationId: "cv1", contactId: "ct9" })

    const res = await POST(req("hello"))
    expect(res.status).toBe(200)
    expect(routeInboundMock.mock.calls[0][1]).toMatchObject({ provider: "WA_CLOUD" })
  })
})

describe("POST /api/webhooks/whatsapp-cloud — STOP consent audit", () => {
  // The route already computes consentRevokedId and returns it; before this fix
  // nothing read it, so a consumer opting out on the LIVE provider produced a
  // REVOKED ContactConsent row with no AuditLog entry. The bridge route has
  // always emitted this. POPIA consent trail.
  it("emits CONSENT_REVOKED_VIA_STOP_KEYWORD when a STOP revokes consent", async () => {
    contactLookupMock.mockResolvedValue({ id: "ct1", tenantId: "tn1" })
    handleWaStopMock.mockResolvedValue({ messageId: "m1", conversationId: "cv1", consentRevokedId: "csn1" })

    const res = await POST(req("STOP"))
    expect(res.status).toBe(200)

    // The STOP branch is a SEPARATE call site from the ordinary known-contact
    // one; a blind review found it unpinned while the others were covered.
    expect(handleWaStopMock.mock.calls[0][1]).toMatchObject({ provider: "WA_CLOUD" })

    const actions = logAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action)
    expect(actions).toContain("CONSENT_REVOKED_VIA_STOP_KEYWORD")

    const consentCall = logAuditMock.mock.calls.find(
      (c) => (c[0] as { action: string }).action === "CONSENT_REVOKED_VIA_STOP_KEYWORD",
    )![0] as { entity: string; entityId: string; newValue: Record<string, unknown> }
    expect(consentCall.entity).toBe("ContactConsent")
    expect(consentCall.entityId).toBe("csn1")
    // source + the subject identifiers are the load-bearing fields on a POPIA
    // revocation row: they tie it to a lawful trigger and a specific consumer.
    expect(consentCall.newValue).toMatchObject({
      channel: "WHATSAPP",
      purpose: "SERVICE_COMMS",
      source: "WA_REPLY_KEYWORD",
      reason: "STOP",
      contactId: "ct1",
      fromValue: "27821234567@s.whatsapp.net",
    })
  })

  it("does not emit the consent audit for an ordinary message", async () => {
    contactLookupMock.mockResolvedValue({ id: "ct1", tenantId: "tn1" })
    handleWaStopMock.mockResolvedValue({ messageId: "m1", conversationId: "cv1", consentRevokedId: null })

    await POST(req("hello"))
    const actions = logAuditMock.mock.calls.map((c) => (c[0] as { action: string }).action)
    expect(actions).not.toContain("CONSENT_REVOKED_VIA_STOP_KEYWORD")
    expect(actions).toContain("MESSAGE_RECEIVED")
  })
})

describe("POST /api/webhooks/whatsapp-cloud — template status updates", () => {
  function templateReq(event: string) {
    return new NextRequest("https://app.acme-lending.example/api/webhooks/whatsapp-cloud", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=x" },
      body: JSON.stringify({
        entry: [{ id: "WABA-1", changes: [{
          field: "message_template_status_update",
          value: { message_template_name: "loan_approved", event, message_template_language: "en" },
        }] }],
      }),
    })
  }

  // Before this, the route fell through to `persisted: false` and silently
  // dropped every template transition despite the subscription existing at
  // Meta — so an approval never reached providerStatus except via the poll,
  // and a PAUSE never reached it at all.
  // The previous version of this test could not fail: findUnique, findFirst
  // and tenant.findUnique all returned the SAME tenant, so "routed by wabaId"
  // and "fell back to NEXT_PUBLIC_TENANT_SLUG" were indistinguishable — and
  // the misrouting defect the routing change exists to fix was untested.
  it("routes a WABA-level event by wabaId, NOT by the slug fallback", async () => {
    vi.stubEnv("NEXT_PUBLIC_TENANT_SLUG", "other")
    commsSettingsFindUnique.mockResolvedValue(null)          // no phone_number_id match
    commsSettingsFindFirst.mockResolvedValue({ tenantId: "tn2" })  // WABA belongs to tn2
    tenantFindUnique.mockResolvedValue({ id: "tn-slug", slug: "other" })
    applyTemplateStatusMock.mockResolvedValue(1)

    const res = await POST(templateReq("APPROVED"))
    expect(res.status).toBe(200)
    expect(commsSettingsFindFirst).toHaveBeenCalledWith({ where: { wabaId: "WABA-1" }, select: { tenantId: true } })
    expect(applyTemplateStatusMock.mock.calls[0][0]).toBe("tn2")
  })

  it("applies an APPROVED transition", async () => {
    applyTemplateStatusMock.mockResolvedValue(1)
    const res = await POST(templateReq("APPROVED"))
    expect(res.status).toBe(200)
    expect(applyTemplateStatusMock).toHaveBeenCalledWith("tn1", [
      { name: "loan_approved", status: "APPROVED", language: "en" },
    ])
  })

  it("audits the transition — it un-gates borrower comms", async () => {
    applyTemplateStatusMock.mockResolvedValue(1)
    await POST(templateReq("PAUSED"))
    const call = logAuditMock.mock.calls.find(
      (c) => (c[0] as { action: string }).action === "WA_TEMPLATE_STATUS_CHANGED",
    )
    expect(call, "a template status change must leave an audit row").toBeDefined()
    expect((call![0] as { newValue: { transitions: unknown[] } }).newValue.transitions).toEqual([
      { name: "loan_approved", status: "PAUSED", language: "en" },
    ])
  })

  it("applies a PAUSED transition — the one the poll can never see", async () => {
    applyTemplateStatusMock.mockResolvedValue(1)
    const res = await POST(templateReq("PAUSED"))
    expect(res.status).toBe(200)
    expect(applyTemplateStatusMock).toHaveBeenCalledWith("tn1", [
      { name: "loan_approved", status: "PAUSED", language: "en" },
    ])
  })

  it("does not reach the message persist path for a template-only update", async () => {
    applyTemplateStatusMock.mockResolvedValue(1)
    await POST(templateReq("APPROVED"))
    expect(handleWaStopMock).not.toHaveBeenCalled()
    expect(routeInboundMock).not.toHaveBeenCalled()
  })

  // Meta batches: entry[] and changes[] are arrays and one POST can carry an
  // inbound message AND a template transition. An early return on the template
  // branch would ack 200 and silently discard the message — and Meta does not
  // retry a 200. Here that message is a STOP, so the dropped write is a POPIA
  // consent revocation.
  it("persists an inbound message batched alongside a template update", async () => {
    applyTemplateStatusMock.mockResolvedValue(1)
    contactLookupMock.mockResolvedValue({ id: "ct1", tenantId: "tn1" })
    handleWaStopMock.mockResolvedValue({ messageId: "m1", conversationId: "cv1", consentRevokedId: "csn1" })

    const req = new NextRequest("https://app.acme-lending.example/api/webhooks/whatsapp-cloud", {
      method: "POST",
      headers: { "x-hub-signature-256": "sha256=x" },
      body: JSON.stringify({
        entry: [
          { id: "WABA-1", changes: [{ field: "messages", value: {
            metadata: { phone_number_id: "PN-OWNER" },
            messages: [{ id: "wamid.batch", from: "27821234567", type: "text", text: { body: "STOP" } }],
          } }] },
          { id: "WABA-1", changes: [{ field: "message_template_status_update", value: {
            message_template_name: "loan_approved", event: "APPROVED", message_template_language: "en",
          } }] },
        ],
      }),
    })

    const res = await POST(req)
    expect(res.status).toBe(200)
    expect(applyTemplateStatusMock).toHaveBeenCalled()
    expect(handleWaStopMock).toHaveBeenCalled()  // the message must NOT be dropped
  })
})
