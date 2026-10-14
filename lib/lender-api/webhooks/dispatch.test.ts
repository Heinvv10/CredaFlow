import { describe, expect, it, vi } from "vitest"

// Bounds of one webhook run, with Prisma mocked: no overlapping runs in a
// process, at most DELIVERY_BATCH POSTs in flight, and the claim loop stops at
// the time budget. The end-to-end path is in lender-api.integration.test.ts.

const h = vi.hoisted(() => ({
  release: null as null | (() => void),
  claims: 0,
  inFlight: 0,
  maxInFlight: 0,
}))

vi.mock("@/lib/prisma", () => {
  const tx = { $queryRaw: async () => [] }
  return {
    prisma: {
      $transaction: async (fn: (t: typeof tx) => unknown) => {
        if (h.release === null) await new Promise<void>((r) => { h.release = r })
        return fn(tx)
      },
      // claimDue: ten due rows per claim, for ever.
      $queryRaw: async () => {
        h.claims++
        return Array.from({ length: 10 }, (_, i) => ({ id: `d${h.claims}-${i}`, endpointId: `ep${h.claims}-${i}`, tenantId: `t${i}` }))
      },
      webhookDelivery: {
        findUniqueOrThrow: async ({ where }: { where: { id: string } }) => ({
          id: where.id, tenantId: "t1", attempts: 0,
          endpoint: { url: "https://hooks.example.com/x", active: true, secretSealed: "x" },
          event: { id: "e1", type: "payment.received", createdAt: new Date(), data: {} },
        }),
        update: async () => ({}),
      },
    },
  }
})
vi.mock("./endpoints", () => ({ webhookSecretKey: () => "k" }))
vi.mock("./circuit-breaker", () => ({ recordEndpointOutcome: async () => null }))
vi.mock("@/lib/crypto/secret-box", () => ({ openSecret: () => "whsec_test" }))
vi.mock("./post", () => ({
  postWebhook: async () => {
    h.inFlight++
    h.maxInFlight = Math.max(h.maxInFlight, h.inFlight)
    await new Promise((r) => setTimeout(r, 20))
    h.inFlight--
    return { ok: false, status: 503, error: "HTTP 503", attempted: true }
  },
}))

import { runWebhookDeliveries } from "./dispatch"

describe("runWebhookDeliveries bounds", () => {
  it("skips a run while another is in progress, caps concurrency at the batch, and stops at the budget", async () => {
    const first = runWebhookDeliveries({ budgetMs: 150 })
    await vi.waitFor(() => expect(h.release).not.toBeNull())
    expect(await runWebhookDeliveries({ budgetMs: 150 })).toMatchObject({ skipped: true })
    h.release!()
    const started = Date.now()
    const r = await first
    expect(Date.now() - started).toBeLessThan(1_000)
    expect(h.maxInFlight).toBeLessThanOrEqual(10)
    expect(r.retrying).toBe(h.claims * 10)
    expect(h.claims).toBeGreaterThan(0)
    expect(h.claims).toBeLessThan(20)
    // the lock is released after the run
    expect((await runWebhookDeliveries({ budgetMs: 0 })).skipped).toBeUndefined()
  })
})
