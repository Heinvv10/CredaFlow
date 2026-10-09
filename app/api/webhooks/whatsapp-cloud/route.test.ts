import { afterEach, describe, it, expect, vi } from "vitest"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findUnique: vi.fn() },
    commsSettings: { findUnique: vi.fn() },
  },
}))
vi.mock("@/lib/webhooks", () => ({
  verifyWaba: vi.fn(),
  writeWebhookSignatureFailure: vi.fn(),
}))

import { GET, POST } from "./route"
import { prisma } from "@/lib/prisma"
import { verifyWaba } from "@/lib/webhooks"

afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks() })

describe("GET /api/webhooks/whatsapp-cloud (verify handshake)", () => {
  it("echoes hub.challenge when mode+token match", async () => {
    vi.stubEnv("WHATSAPP_CLOUD_VERIFY_TOKEN", "verify-me")
    const url = "https://x/api/webhooks/whatsapp-cloud?hub.mode=subscribe&hub.verify_token=verify-me&hub.challenge=42"
    const res = await GET(new Request(url) as never)
    expect(res.status).toBe(200)
    expect(await res.text()).toBe("42")
  })

  it("403s when the token does not match", async () => {
    vi.stubEnv("WHATSAPP_CLOUD_VERIFY_TOKEN", "verify-me")
    const url = "https://x/api/webhooks/whatsapp-cloud?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=42"
    const res = await GET(new Request(url) as never)
    expect(res.status).toBe(403)
  })
})

describe("POST /api/webhooks/whatsapp-cloud (tenant routing)", () => {
  it("routes POST to the tenant that owns the phone_number_id", async () => {
    vi.stubEnv("WHATSAPP_CLOUD_APP_SECRET", "sek")
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue({ tenantId: "tn-owner" } as never)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ id: "tn-owner", slug: "owner" } as never)
    vi.mocked(verifyWaba).mockReturnValue({ ok: true } as never)

    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "PN-OWNER" }, statuses: [] } }] }] })
    const res = await POST(new Request("http://x/api/webhooks/whatsapp-cloud", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=x" } }) as never)
    expect(res.status).toBe(200)
    expect(prisma.commsSettings.findUnique).toHaveBeenCalledWith({ where: { wabaPhoneNumberId: "PN-OWNER" }, select: { tenantId: true } })
  })

  it("falls back to slug when phone_number_id has no matching CommsSettings row", async () => {
    vi.stubEnv("WHATSAPP_CLOUD_APP_SECRET", "sek")
    vi.stubEnv("NEXT_PUBLIC_TENANT_SLUG", "owner")
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue({ id: "tn-owner", slug: "owner" } as never)
    vi.mocked(verifyWaba).mockReturnValue({ ok: true } as never)

    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "PN-UNKNOWN" }, statuses: [] } }] }] })
    const res = await POST(new Request("http://x/api/webhooks/whatsapp-cloud", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=x" } }) as never)
    expect(res.status).toBe(200)
    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({ where: { slug: "owner" } })
  })

  it("500s when neither phone_number_id nor slug resolves a tenant", async () => {
    vi.stubEnv("WHATSAPP_CLOUD_APP_SECRET", "sek")
    vi.mocked(prisma.commsSettings.findUnique).mockResolvedValue(null)
    vi.mocked(prisma.tenant.findUnique).mockResolvedValue(null)
    vi.mocked(verifyWaba).mockReturnValue({ ok: true } as never)

    const body = JSON.stringify({ entry: [{ changes: [{ value: { metadata: { phone_number_id: "PN-UNKNOWN" }, statuses: [] } }] }] })
    const res = await POST(new Request("http://x/api/webhooks/whatsapp-cloud", { method: "POST", body, headers: { "x-hub-signature-256": "sha256=x" } }) as never)
    expect(res.status).toBe(500)
  })
})
