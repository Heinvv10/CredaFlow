import { beforeEach, describe, expect, it, vi } from "vitest"

const h = vi.hoisted(() => ({ enabled: true, ran: [] as string[], release: null as null | (() => void) }))
vi.mock("./enabled", () => ({ statementAiEnabled: async () => h.enabled }))
vi.mock("./model", () => ({ modelAvailable: () => true }))
vi.mock("./generate", () => ({
  planOutputs: async (_t: string, a: string) => {
    h.ran.push(`app:${a}`)
    if (h.release) await new Promise<void>((r) => { h.release = r })
    return { plans: [] }
  },
  missing: async () => [],
  generate: async () => undefined,
}))
vi.mock("./ask/run", () => ({ runQuestion: async (_t: string, _a: string, o: string) => { h.ran.push(`q:${o}`) } }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/credit-checks/recompute", () => ({ RECOMPUTE_STATUSES: [] }))

import { drained, enqueue, enqueueApplication, enqueueQuestion, MAX_WAITING_PER_TENANT } from "./worker"

beforeEach(async () => {
  await drained()
  h.enabled = true
  h.ran = []
  h.release = null
})

describe("worker queue", () => {
  it("runs jobs one at a time, in order, and nothing while the lender has it off", async () => {
    expect(enqueueApplication("t1", "a1")).toBe(true)
    expect(enqueueQuestion("t1", "a1", "o1")).toBe(true)
    await drained()
    expect(h.ran).toEqual(["app:a1", "q:o1"])
    h.enabled = false
    enqueueApplication("t1", "a2")
    await drained()
    expect(h.ran).toEqual(["app:a1", "q:o1"])
  })

  it("does not queue a job already waiting or running", async () => {
    h.release = () => undefined
    expect(enqueueApplication("t1", "a1")).toBe(true)
    expect(enqueueApplication("t1", "a1")).toBe(false)
    await vi.waitFor(() => expect(h.ran).toEqual(["app:a1"]))
    // Running now: asking again is refused too.
    expect(enqueueApplication("t1", "a1")).toBe(false)
    h.release!()
    await drained()
  })

  it("caps one tenant's waiting jobs so it cannot crowd out the others", async () => {
    h.release = () => undefined
    enqueueApplication("t1", "busy")
    await vi.waitFor(() => expect(h.ran).toEqual(["app:busy"]))
    for (let i = 0; i < MAX_WAITING_PER_TENANT; i++) expect(enqueue({ type: "application", tenantId: "t1", applicationId: `a${i}` })).toBe(true)
    expect(enqueueApplication("t1", "one-too-many")).toBe(false)
    expect(enqueueApplication("t2", "other-tenant")).toBe(true)
    h.release!()
    h.release = null
    await drained()
    expect(h.ran).toContain("app:other-tenant")
    expect(h.ran).not.toContain("app:one-too-many")
  })
})
