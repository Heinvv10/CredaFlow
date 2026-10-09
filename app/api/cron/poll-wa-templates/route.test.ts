import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

vi.mock("@/lib/prisma", () => ({ prisma: {
  messageTemplate: { findMany: vi.fn(), update: vi.fn() },
} }))
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: vi.fn() }))
vi.mock("@/lib/tenant", () => ({ getTenantFromRequest: vi.fn() }))
vi.mock("@/lib/whatsapp-cloud-config", () => ({
  getWabaTemplateCreds: vi.fn(),
  WabaNotConfiguredError: class WabaNotConfiguredError extends Error {
    constructor(tenantId: string) {
      super(`WhatsApp Cloud credentials are not configured for tenant ${tenantId}`)
      this.name = "WabaNotConfiguredError"
    }
  },
}))
vi.mock("@/lib/whatsapp/graph-templates", () => ({ fetchWabaTemplateStatus: vi.fn() }))

import { prisma } from "@/lib/prisma"
import { verifyCronSecret } from "@/lib/cron-auth"
import { getTenantFromRequest } from "@/lib/tenant"
import { getWabaTemplateCreds, WabaNotConfiguredError } from "@/lib/whatsapp-cloud-config"
import { fetchWabaTemplateStatus } from "@/lib/whatsapp/graph-templates"
import { GET } from "./route"

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(verifyCronSecret).mockReturnValue(null)
  vi.mocked(getTenantFromRequest).mockResolvedValue({ id: "tn1" } as never)
  vi.mocked(getWabaTemplateCreds).mockResolvedValue({ wabaId: "WABA1", accessToken: "TOK" })
})

it("refreshes providerStatus for each PENDING template that changed", async () => {
  vi.mocked(prisma.messageTemplate.findMany).mockResolvedValue([
    { id: "tpl1", wabaTemplateName: "review_ask" },
    { id: "tpl2", wabaTemplateName: "reminder" },
  ] as never)
  vi.mocked(fetchWabaTemplateStatus).mockResolvedValueOnce("APPROVED").mockResolvedValueOnce("PENDING")

  const res = await GET(new NextRequest("http://x/api/cron/poll-wa-templates"))
  expect(res.status).toBe(200)
  expect(prisma.messageTemplate.update).toHaveBeenCalledTimes(1)
  expect(prisma.messageTemplate.update).toHaveBeenCalledWith({
    where: { id: "tpl1", tenantId: "tn1" }, data: { providerStatus: "APPROVED" },
  })
})

it("401s on a bad cron secret without touching the DB", async () => {
  const { NextResponse } = await import("next/server")
  vi.mocked(verifyCronSecret).mockReturnValue(NextResponse.json({ error: "unauthorized" }, { status: 401 }))
  const res = await GET(new NextRequest("http://x/api/cron/poll-wa-templates"))
  expect(res.status).toBe(401)
  expect(prisma.messageTemplate.findMany).not.toHaveBeenCalled()
})

// A PARTIAL failure intentionally stays 200: that batch still did real work,
// and fetchWabaTemplateStatus (lib/whatsapp/graph-templates.ts) has no
// retry/backoff of its own, so one transient Meta 5xx on one of N templates
// would otherwise red the whole run every time it happens — training an
// operator to stop trusting (and start ignoring) the alert. Only a run where
// EVERY poll failed (below) is treated as a failed run.
it("continues the batch when one template's status poll throws, and still reports 200", async () => {
  vi.mocked(prisma.messageTemplate.findMany).mockResolvedValue([
    { id: "tpl1", wabaTemplateName: "review_ask" },
    { id: "tpl2", wabaTemplateName: "reminder" },
  ] as never)
  vi.mocked(fetchWabaTemplateStatus)
    .mockRejectedValueOnce(new Error("meta 500"))
    .mockResolvedValueOnce("APPROVED")

  const res = await GET(new NextRequest("http://x/api/cron/poll-wa-templates"))
  expect(res.status).toBe(200)
  const body = await res.json()
  // The batch still ran to completion — tpl2 was polled and updated.
  expect(prisma.messageTemplate.update).toHaveBeenCalledTimes(1)
  expect(prisma.messageTemplate.update).toHaveBeenCalledWith({
    where: { id: "tpl2", tenantId: "tn1" }, data: { providerStatus: "APPROVED" },
  })
  expect(body.errors).toBe(1)
  expect(body.ok).toBe(true)
})

// A run where EVERY poll failed accomplished nothing, but instrumentation.ts
// only inspects res.ok — so a 200 here prints "[cron] …poll-wa-templates ok"
// while an expired WABA token silently blocks every template approval from
// ever landing. The sibling check-wa-bridge-status fails when its upstream
// is unreachable; this is the same situation.
it("returns 503 when EVERY template poll failed (the run achieved nothing)", async () => {
  vi.mocked(prisma.messageTemplate.findMany).mockResolvedValue([
    { id: "tpl1", wabaTemplateName: "review_ask" },
    { id: "tpl2", wabaTemplateName: "reminder" },
  ] as never)
  vi.mocked(fetchWabaTemplateStatus)
    .mockRejectedValueOnce(new Error("meta 401"))
    .mockRejectedValueOnce(new Error("meta 401"))

  const res = await GET(new NextRequest("http://x/api/cron/poll-wa-templates"))
  expect(res.status).toBe(503)
  const body = await res.json()
  expect(body.ok).toBe(false)
  expect(body.errors).toBe(2)
  expect(prisma.messageTemplate.update).not.toHaveBeenCalled()
})

it("reports ok:true and 200 when there are no PENDING templates (empty sweep)", async () => {
  vi.mocked(prisma.messageTemplate.findMany).mockResolvedValue([] as never)

  const res = await GET(new NextRequest("http://x/api/cron/poll-wa-templates"))
  const body = await res.json()
  expect(res.status).toBe(200)
  expect(body).toMatchObject({ ok: true, checked: 0, updated: 0 })
})

it("returns 200 skipped when the tenant has no WABA creds", async () => {
  vi.mocked(prisma.messageTemplate.findMany).mockResolvedValue([
    { id: "tpl1", wabaTemplateName: "review_ask" },
  ] as never)
  vi.mocked(getWabaTemplateCreds).mockRejectedValue(new WabaNotConfiguredError("tn1"))

  const res = await GET(new NextRequest("http://x/api/cron/poll-wa-templates"))
  expect(res.status).toBe(200)
  expect(prisma.messageTemplate.update).not.toHaveBeenCalled()
})
