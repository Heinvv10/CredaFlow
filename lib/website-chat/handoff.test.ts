import { beforeEach, describe, expect, it, vi } from "vitest"

const m = vi.hoisted(() => ({ users: [] as { id: string; role: string; isCommsAgent: boolean }[], rung: [] as { entityId: string | null }[], notify: vi.fn() }))
const tx = { user: { findMany: async () => m.users }, notification: { findMany: async () => m.rung }, $executeRaw: async () => 0 }
vi.mock("@/lib/prisma", () => ({ prisma: { $transaction: (fn: (t: typeof tx) => unknown) => fn(tx) } }))
vi.mock("@/lib/notifications/bell", () => ({ createNotification: m.notify }))
vi.mock("./store", () => ({ visitorLead: async () => ({ firstName: "Sipho" }) }))

import { notifyStaffOfHandoff } from "./handoff"

const args = { tenantId: "t1", conversationId: "conv_1", now: new Date("2026-09-29T10:00:00Z") }

beforeEach(() => {
  vi.clearAllMocks()
  m.rung = []
})

describe("notifyStaffOfHandoff: who is rung", () => {
  // The query is only a cheap pre-filter; isCommsAgentAllowed is the one definition of
  // inbox access. No role in today's enum is below READONLY, so this guards the day one
  // is added (or a CLIENT row reaches the table) with the comms flag set.
  it("rings no one the inbox-access rule refuses, even with the comms flag set", async () => {
    m.users = [
      { id: "u_admin", role: "ADMIN", isCommsAgent: false },
      { id: "u_flagged", role: "CREDIT_OFFICER", isCommsAgent: true },
      { id: "u_client", role: "CLIENT", isCommsAgent: true },
      { id: "u_unknown", role: "SOMETHING_NEW", isCommsAgent: true },
    ]
    await notifyStaffOfHandoff(args)
    expect(m.notify.mock.calls.map(([n]) => n.userId)).toEqual(["u_admin", "u_flagged"])
  })
})
