import { describe, expect, it } from "vitest"
import { chatMode, HANDOFF_WAIT_MS } from "./mode"

const base = { closedAt: null, status: "OPEN", assigneeId: null }

describe("chatMode", () => {
  it("is ended whenever closedAt is set", () => {
    const c = { closedAt: new Date(), status: "PENDING_INTERNAL", assigneeId: "u1" }
    expect(chatMode(c, { timedOutAt: null })).toBe("ended")
  })
  it("is staff when assigned", () => {
    expect(chatMode({ ...base, assigneeId: "u1" }, null)).toBe("staff")
    expect(chatMode({ ...base, status: "PENDING_INTERNAL", assigneeId: "u1" }, { timedOutAt: null })).toBe("staff")
  })
  it("is waiting while a handoff is pending", () => {
    expect(chatMode({ ...base, status: "PENDING_INTERNAL" }, { timedOutAt: null })).toBe("waiting")
  })
  it("is fallback once the handoff timed out", () => {
    expect(chatMode({ ...base, status: "PENDING_INTERNAL" }, { timedOutAt: new Date() })).toBe("fallback")
  })
  it("is fallback for a pending chat with no handoff row", () => {
    expect(chatMode({ ...base, status: "PENDING_INTERNAL" }, null)).toBe("fallback")
  })
  it("is bot when open and unassigned", () => {
    expect(chatMode(base, null)).toBe("bot")
  })
  it("waits two minutes for staff", () => {
    expect(HANDOFF_WAIT_MS).toBe(120_000)
  })
})
