import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ replay: vi.fn() }))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ user: { id: "u1", email: "admin@example.test" } })),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: async (_req: Request, fn: (tenant: { id: string }) => Promise<Response>) => fn({ id: "t1" }),
}))
vi.mock("@/lib/automation/engine", () => ({ replayAutomationLog: h.replay }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { POST } from "./route"

const call = () => POST(new Request("http://localhost/api/automation/logs/log1/replay", { method: "POST" }), {
  params: Promise.resolve({ id: "log1" }),
})

beforeEach(() => vi.clearAllMocks())

describe("POST /api/automation/logs/[id]/replay", () => {
  it("answers 422 with the reason when the replay is refused (not a 500)", async () => {
    h.replay.mockRejectedValue(new Error("WhatsApp reminders are no longer sent by the automation engine; they are handled by the reminders cron, so this entry cannot be replayed"))
    const res = await call()
    expect(res.status).toBe(422)
    expect((await res.json()).error).toMatch(/reminders cron/)
  })

  it("answers 404 for an unknown log", async () => {
    h.replay.mockRejectedValue(new Error("Log entry not found"))
    expect((await call()).status).toBe(404)
  })

  it("returns the replay outcome", async () => {
    h.replay.mockResolvedValue({ result: "success" })
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: "success" })
  })
})
