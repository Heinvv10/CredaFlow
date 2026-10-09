import { describe, it, expect, vi } from "vitest"
import { Prisma } from "@prisma/client"
import {
  notifyPriorLeadDuplicates,
  notifyPriorLeadDuplicatesBestEffort,
  type NotifyDeps,
} from "@/lib/crm/lead-duplicate-notify"

// These fakes prove ORDERING and ERROR HANDLING, which is all a fake can prove.
// That the throttle's unique constraint actually serialises concurrent claims
// is a database fact and is covered by the integration test — a fake cannot
// execute a unique index, and treating this file as proof of the race would be
// the mistake CLAUDE.md warns about.

const NOW = Date.parse("2026-08-15T09:41:00.000Z")

const priorLead = (over: Record<string, unknown> = {}) => ({
  id: "old",
  firstName: "Nhlanhla",
  lastName: "Mocktest",
  phone: "0820000048",
  status: "CONTACTED",
  assignedToId: "agent_1",
  convertedToClientId: null,
  convertedToApplicationId: null,
  conversionRecoveryRequired: false,
  ...over,
})

const newLead = { id: "new", firstName: "Nhlanhla", lastName: "Mocktest", phone: "+27820000048" }

function deps(over: Partial<NotifyDeps> = {}, candidates = [priorLead()]) {
  const calls: string[] = []
  const base: NotifyDeps = {
    leads: {
      findMany: vi.fn(async () => {
        calls.push("findMany")
        return candidates as never
      }),
    },
    throttle: {
      create: vi.fn(async () => { calls.push("claim"); return {} }),
      delete: vi.fn(async () => { calls.push("release"); return {} }),
    },
    notify: vi.fn(async () => { calls.push("bell"); return {} }),
    email: vi.fn(async () => { calls.push("email"); return {} }),
    now: () => NOW,
    ...over,
  }
  return { deps: base, calls }
}

const p2002 = () =>
  new Prisma.PrismaClientKnownRequestError("unique", { code: "P2002", clientVersion: "5" })

describe("notifyPriorLeadDuplicates", () => {
  it("claims the throttle BEFORE sending anything", async () => {
    // Reversing these is the check-then-act race: two concurrent applications
    // would both send before either claimed.
    const { deps: d, calls } = deps()
    await notifyPriorLeadDuplicates(newLead, "t1", d)
    expect(calls).toEqual(["findMany", "claim", "bell", "email"])
  })

  it("scopes the candidate query to the tenant", async () => {
    // Lead is absent from TENANT_SCOPED_MODELS — nothing upstream adds this.
    const { deps: d } = deps()
    await notifyPriorLeadDuplicates(newLead, "t1", d)
    expect(d.leads.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ tenantId: "t1" }) })
    )
  })

  it("sends nothing when no prior lead matches", async () => {
    const { deps: d, calls } = deps({}, [priorLead({ firstName: "Marie" })])
    const out = await notifyPriorLeadDuplicates(newLead, "t1", d)
    expect(out).toEqual({ matched: 0, notified: 0, skippedByThrottle: 0 })
    expect(calls).toEqual(["findMany"])
  })

  it("matches but notifies nobody when the prior lead is unassigned", async () => {
    const { deps: d, calls } = deps({}, [priorLead({ assignedToId: null })])
    const out = await notifyPriorLeadDuplicates(newLead, "t1", d)
    expect(out.matched).toBe(1)
    expect(out.notified).toBe(0)
    expect(calls).toEqual(["findMany"])
  })

  it("skips silently when another request already claimed the window", async () => {
    const { deps: d, calls } = deps({
      throttle: {
        create: vi.fn(async () => { throw p2002() }),
        delete: vi.fn(async () => ({})),
      },
    })
    const out = await notifyPriorLeadDuplicates(newLead, "t1", d)
    expect(out.skippedByThrottle).toBe(1)
    expect(out.notified).toBe(0)
    expect(calls).toEqual(["findMany"])
  })

  it("RELEASES the claim when the bell insert fails", async () => {
    // Otherwise one transient failure suppresses this agent's notices for the
    // rest of the 6h window.
    const { deps: d, calls } = deps({ notify: vi.fn(async () => { throw new Error("db down") }) })
    await expect(notifyPriorLeadDuplicates(newLead, "t1", d)).rejects.toThrow("db down")
    expect(calls).toEqual(["findMany", "claim", "release"])
  })

  it("KEEPS the claim when only the email fails, and still counts as notified", async () => {
    // The bell item is already written and cannot be un-written. Releasing the
    // claim here let the NEXT genuine submission insert a second bell item for
    // the same prior lead, so one SMTP blip produced a duplicate alert — the
    // exact thing the throttle exists to prevent.
    const { deps: d, calls } = deps({ email: vi.fn(async () => { throw new Error("smtp down") }) })
    const out = await notifyPriorLeadDuplicates(newLead, "t1", d)
    expect(out.notified).toBe(1)
    // No "email" entry: the overriding mock throws before it records.
    expect(calls).toEqual(["findMany", "claim", "bell"])
    expect(d.throttle.delete).not.toHaveBeenCalled()
  })

  it("does not reject when only the email fails", async () => {
    const { deps: d } = deps({ email: vi.fn(async () => { throw new Error("smtp down") }) })
    await expect(notifyPriorLeadDuplicates(newLead, "t1", d)).resolves.toBeDefined()
  })

  it("does not let a failed release mask the original BELL error", async () => {
    const { deps: d } = deps({
      notify: vi.fn(async () => { throw new Error("original") }),
      throttle: {
        create: vi.fn(async () => ({})),
        delete: vi.fn(async () => { throw new Error("release also failed") }),
      },
    })
    await expect(notifyPriorLeadDuplicates(newLead, "t1", d)).rejects.toThrow("original")
  })

  it("sends one notice per agent when one agent owns two matching leads", async () => {
    const { deps: d } = deps({}, [
      priorLead({ id: "a", assignedToId: "agent_1" }),
      priorLead({ id: "b", assignedToId: "agent_1" }),
    ])
    const out = await notifyPriorLeadDuplicates(newLead, "t1", d)
    expect(out.matched).toBe(2)
    expect(out.notified).toBe(1)
    expect(d.notify).toHaveBeenCalledTimes(1)
  })

  it("deep-links the bell item at the prior lead, not the new one", async () => {
    const { deps: d } = deps()
    await notifyPriorLeadDuplicates(newLead, "t1", d)
    expect(d.notify).toHaveBeenCalledWith(expect.objectContaining({ entityId: "old" }))
  })
})

describe("notifyPriorLeadDuplicatesBestEffort", () => {
  it("swallows any error so an applicant's submission cannot fail", async () => {
    // THE contract. This runs inside a consumer's loan application.
    const { deps: d } = deps({
      leads: { findMany: vi.fn(async () => { throw new Error("lock timeout") }) },
    })
    await expect(notifyPriorLeadDuplicatesBestEffort(newLead, "t1", d)).resolves.toBeUndefined()
  })

  it("swallows a send failure too", async () => {
    const { deps: d } = deps({ email: vi.fn(async () => { throw new Error("smtp down") }) })
    await expect(notifyPriorLeadDuplicatesBestEffort(newLead, "t1", d)).resolves.toBeUndefined()
  })
})
