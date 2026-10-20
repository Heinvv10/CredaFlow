import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ create: vi.fn() }))

vi.mock("@/lib/prisma", () => ({ prisma: { automationRule: { create: h.create, findMany: vi.fn() } } }))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn(async () => ({ user: { id: "u1", email: "admin@example.test" } })),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: async (_req: Request, fn: (tenant: { id: string }) => Promise<Response>) => fn({ id: "t1" }),
}))

import { NextRequest } from "next/server"
import { POST } from "./route"

const post = (body: unknown) => POST(new NextRequest("http://localhost/api/automation/rules", {
  method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
}))

beforeEach(() => {
  vi.clearAllMocks()
  h.create.mockResolvedValue({ id: "r1" })
})

describe("POST /api/automation/rules", () => {
  it("refuses a new SEND_WA rule (WhatsApp reminders belong to the reminders cron)", async () => {
    const res = await post({ name: "WA", trigger: "DPD_THRESHOLD", condition: {}, action: "SEND_WA" })
    expect(res.status).toBe(422)
    expect(h.create).not.toHaveBeenCalled()
  })

  it("still creates a non-WhatsApp rule", async () => {
    const res = await post({ name: "Task", trigger: "DPD_THRESHOLD", condition: {}, action: "CREATE_AGENT_TASK" })
    expect(res.status).toBe(201)
    expect(h.create).toHaveBeenCalledTimes(1)
  })
})
