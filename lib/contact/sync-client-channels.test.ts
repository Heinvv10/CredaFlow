import { describe, expect, it, vi } from "vitest"
import { contactMatchesClient, syncClientContactChannels } from "./sync-client-channels"

function tx(contact: object | null, holder: object | null = null) {
  const deleteMany = vi.fn(async (_: unknown) => ({ count: 1 }))
  const create = vi.fn(async (_: unknown) => ({}))
  const update = vi.fn(async (_: unknown) => ({}))
  return { deleteMany, create, update, db: { contact: { findFirst: async () => contact, update }, contactIdentity: { deleteMany, create, findFirst: async () => holder } } as never }
}
const contact = { id: "ct1", primaryEmail: "old@x.invalid", primaryWaJid: "26658000001@s.whatsapp.net" }
const scope = { tenantId: "t1", clientId: "c1" }

describe("syncClientContactChannels", () => {
  it("replaces the email identity and the primary", async () => {
    const { db, deleteMany, create, update } = tx(contact)
    expect(await syncClientContactChannels(db, { ...scope, before: { email: "old@x.invalid" }, after: { email: "New@X.invalid" } })).toEqual([])
    expect(deleteMany).toHaveBeenCalledWith({ where: { tenantId: "t1", contactId: "ct1", channel: "EMAIL", value: { in: ["old@x.invalid", "old@x.invalid"] } } })
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ tenantId: "t1", contactId: "ct1", channel: "EMAIL", value: "new@x.invalid" }) })
    expect(update).toHaveBeenCalledWith({ where: { id: "ct1" }, data: { primaryEmail: "new@x.invalid" } })
  })

  it("replaces the WhatsApp identity in its JID form, and clears it when the number goes", async () => {
    const { db, create, update } = tx(contact)
    await syncClientContactChannels(db, { ...scope, before: { whatsapp: "+26658000001" }, after: { whatsapp: "+26658000002" } })
    expect(create).toHaveBeenCalledWith({ data: expect.objectContaining({ channel: "WHATSAPP", value: "26658000002@s.whatsapp.net" }) })
    const cleared = tx(contact)
    await syncClientContactChannels(cleared.db, { ...scope, before: { whatsapp: "+26658000001" }, after: { whatsapp: null } })
    expect(cleared.create).not.toHaveBeenCalled()
    expect(cleared.update).toHaveBeenCalledWith({ where: { id: "ct1" }, data: { primaryWaJid: null } })
    expect(update).toHaveBeenCalled()
  })

  it("also removes what the Contact held from before this change, so a record already stale is corrected", async () => {
    const { db, deleteMany } = tx({ ...contact, primaryEmail: "older@x.invalid" })
    await syncClientContactChannels(db, { ...scope, before: { email: "old@x.invalid" }, after: { email: "new@x.invalid" } })
    expect(deleteMany.mock.calls[0][0]).toMatchObject({ where: { value: { in: ["old@x.invalid", "older@x.invalid"] } } })
  })

  it("does not take a value another Contact holds: this Contact has none on that channel, and it says so", async () => {
    const { db, create, update } = tx(contact, { contactId: "someone-else" })
    expect(await syncClientContactChannels(db, { ...scope, before: { email: "old@x.invalid" }, after: { email: "taken@x.invalid" } })).toEqual(["EMAIL"])
    expect(create).not.toHaveBeenCalled()
    expect(update).toHaveBeenCalledWith({ where: { id: "ct1" }, data: { primaryEmail: null } })
  })

  it("does nothing when neither changed (a case change is no change), or the client has no Contact", async () => {
    const same = tx(contact)
    await syncClientContactChannels(same.db, { ...scope, before: { email: "OLD@x.invalid", whatsapp: "+26658000001" }, after: { email: "old@x.invalid", whatsapp: "26658000001" } })
    expect(same.deleteMany).not.toHaveBeenCalled()
    const none = tx(null)
    expect(await syncClientContactChannels(none.db, { ...scope, before: { email: "a@x.invalid" }, after: { email: "b@x.invalid" } })).toEqual([])
    expect(none.create).not.toHaveBeenCalled()
  })
})

describe("contactMatchesClient", () => {
  it("compares normalised values, channel by channel", () => {
    expect(contactMatchesClient("EMAIL", contact, { email: "OLD@x.invalid" })).toBe(true)
    expect(contactMatchesClient("EMAIL", contact, { email: "new@x.invalid" })).toBe(false)
    expect(contactMatchesClient("WHATSAPP", contact, { whatsapp: "+26658000001" })).toBe(true)
    expect(contactMatchesClient("WHATSAPP", contact, { whatsapp: null })).toBe(false)
  })
})
