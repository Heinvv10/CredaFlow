import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ replay: vi.fn() }))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ user: { id: "u1", email: "admin@example.test" } })),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: async (_req: Request, fn: (tenant: { id: string }) => Promise<Response>) => fn({ id: "t1" }),
}))
vi.mock("@/lib/automation/engine", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/automation/engine")>()),
  replayAutomationLog: h.replay,
}))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))

import { AutomationReplayRefusedError } from "@/lib/automation/engine"
import { POST } from "./route"

const call = () => POST(new Request("http://localhost/api/automation/logs/log1/replay", { method: "POST" }), {
  params: Promise.resolve({ id: "log1" }),
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, "error").mockImplementation(() => {})
})

describe("POST /api/automation/logs/[id]/replay", () => {
  it.each([
    ["not_failed", 422],
    ["paused", 422],
    ["whatsapp_retired", 422],
    ["not_found", 404],
  ] as const)("answers %s with %i and the reason", async (code, status) => {
    h.replay.mockRejectedValue(new AutomationReplayRefusedError(code, `refused: ${code}`))
    const res = await call()
    expect(res.status).toBe(status)
    expect((await res.json()).error).toBe(`refused: ${code}`)
  })

  it("answers an unexpected error with a generic 500, logged, never the raw message", async () => {
    h.replay.mockRejectedValue(new Error("connection to 10.0.0.5 refused, password=hunter2 not found"))
    const res = await call()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Replay failed" })
    expect(console.error).toHaveBeenCalled()
  })

  it("returns the replay outcome", async () => {
    h.replay.mockResolvedValue({ result: "success" })
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ result: "success" })
  })
})
