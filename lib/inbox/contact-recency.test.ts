import { describe, it, expect, vi } from "vitest"
import { touchContactInbound } from "./contact-recency"

function fakeTx(existing: unknown) {
  return {
    contact: {
      findUnique: vi.fn(async () => ({ lastInboundAtByChannel: existing })),
      update: vi.fn(async () => ({ id: "ct_a" })),
    },
  }
}

const now = new Date("2026-08-11T19:33:12.000Z")

describe("touchContactInbound", () => {
  it("writes the channel timestamp when the JSON is null", async () => {
    const tx = fakeTx(null)
    await touchContactInbound(tx, { contactId: "ct_a", channel: "WHATSAPP", now })
    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "ct_a" },
      data: { lastInboundAtByChannel: { WHATSAPP: "2026-08-11T19:33:12.000Z" } },
    })
  })

  it("merges rather than replaces — a sibling channel survives", async () => {
    const tx = fakeTx({ EMAIL: "2026-01-01T00:00:00.000Z" })
    await touchContactInbound(tx, { contactId: "ct_a", channel: "WHATSAPP", now })
    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "ct_a" },
      data: {
        lastInboundAtByChannel: {
          EMAIL: "2026-01-01T00:00:00.000Z",
          WHATSAPP: "2026-08-11T19:33:12.000Z",
        },
      },
    })
  })

  it("advances a stale timestamp for the same channel", async () => {
    const tx = fakeTx({ WHATSAPP: "2026-07-14T08:00:00.000Z" })
    await touchContactInbound(tx, { contactId: "ct_a", channel: "WHATSAPP", now })
    expect(tx.contact.update).toHaveBeenCalledWith({
      where: { id: "ct_a" },
      data: { lastInboundAtByChannel: { WHATSAPP: "2026-08-11T19:33:12.000Z" } },
    })
  })
})
