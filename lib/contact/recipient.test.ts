import { describe, expect, it, vi } from "vitest"
import { lookupRecipientContact } from "./recipient"

const db = (contact: { id: string; clientId: string | null } | null) => ({
  contactIdentity: { findFirst: vi.fn(async () => (contact ? { contact } : null)) },
}) as never
const opts = { tenantId: "t1", channel: "WHATSAPP" as const, value: "27820000001@s.whatsapp.net" }

describe("lookupRecipientContact", () => {
  it("returns the recipient's own Contact", async () => {
    expect(await lookupRecipientContact(db({ id: "ct1", clientId: "cl1" }), { ...opts, ownerClientId: "cl1" })).toEqual({ ok: true, contact: { id: "ct1", clientId: "cl1" } })
  })

  it("refuses a Contact another client owns", async () => {
    expect(await lookupRecipientContact(db({ id: "ct2", clientId: "cl2" }), { ...opts, ownerClientId: "cl1" })).toEqual({ ok: false, reason: "OTHER_OWNER" })
  })

  it("refuses a lead's Contact (owned by no client) for a client's message", async () => {
    expect(await lookupRecipientContact(db({ id: "ct3", clientId: null }), { ...opts, ownerClientId: "cl1" })).toEqual({ ok: false, reason: "OTHER_OWNER" })
  })

  it("says when there is no Contact at all", async () => {
    expect(await lookupRecipientContact(db(null), { ...opts, ownerClientId: "cl1" })).toEqual({ ok: false, reason: "NO_CONTACT" })
  })

  it("with no owner (no Client in the flow) takes whatever Contact holds the value", async () => {
    expect(await lookupRecipientContact(db({ id: "ct3", clientId: null }), { ...opts, ownerClientId: null })).toEqual({ ok: true, contact: { id: "ct3", clientId: null } })
  })
})
