import { describe, expect, it, vi } from "vitest"
import { contactMatchesClient, syncClientContactChannels } from "./sync-client-channels"

function tx(contact: object | null, holder: object | null = null) {
  const deleteMany = vi.fn(async (_: unknown) => ({ count: 1 }))
  const create = vi.fn(async (_: unknown) => ({}))
  const update = vi.fn(async (_: unknown) => ({}))
  const identityUpdate = vi.fn(async (_: unknown) => ({}))
  const contactCreate = vi.fn(async (a: { data: object }) => ({ id: "ct-new", primaryEmail: null, primaryWaJid: null, staffAddressUnresolvedAt: null, ...a.data }))
  return { deleteMany, create, update, identityUpdate, contactCreate, db: {
    $queryRaw: async () => [], client: { findFirst: async () => ({ firstName: "A", lastName: "B", phone: "+26658000001", deceasedAt: null }) },
    contact: { findFirst: async () => contact, update, create: contactCreate }, contactIdentity: { deleteMany, create, update: identityUpdate, findFirst: async () => holder },
  } as never }
}
const contact = { id: "ct1", primaryEmail: "old@x.invalid", primaryWaJid: "26658000001@s.whatsapp.net", staffAddressUnresolvedAt: null as Date | null }
const scope = { tenantId: "t1", clientId: "c1", setByStaffUserId: null }

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

  it("records who set it: a staff change carries the staff member, a borrower's own change carries none", async () => {
    const staff = tx(contact)
    await syncClientContactChannels(staff.db, { ...scope, setByStaffUserId: "u9", before: { email: "old@x.invalid" }, after: { email: "new@x.invalid" } })
    expect(staff.create).toHaveBeenCalledWith({ data: expect.objectContaining({ setByStaffUserId: "u9" }) })
    const own = tx(contact)
    await syncClientContactChannels(own.db, { ...scope, before: { whatsapp: "+26658000001" }, after: { whatsapp: "+26658000002" } })
    expect(own.create).toHaveBeenCalledWith({ data: expect.objectContaining({ setByStaffUserId: null }) })
  })

  it("a value this Contact already held, chosen again by staff, is unverified again", async () => {
    const { db, identityUpdate, create } = tx(contact, { id: "i1", contactId: "ct1" })
    await syncClientContactChannels(db, { ...scope, setByStaffUserId: "u9", before: { email: "old@x.invalid" }, after: { email: "again@x.invalid" } })
    expect(create).not.toHaveBeenCalled()
    expect(identityUpdate).toHaveBeenCalledWith({ where: { id: "i1" }, data: { setByStaffUserId: "u9", confirmedAt: null, confirmedByUserId: null } })
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

  it("does nothing when neither changed: a case change is no change", async () => {
    const same = tx(contact)
    await syncClientContactChannels(same.db, { ...scope, before: { email: "OLD@x.invalid", whatsapp: "+26658000001" }, after: { email: "old@x.invalid", whatsapp: "26658000001" } })
    expect(same.deleteMany).not.toHaveBeenCalled()
    const none = tx(null)
    await syncClientContactChannels(none.db, { ...scope, before: { email: "a@x.invalid" }, after: { email: "a@x.invalid" } })
    expect(none.contactCreate).not.toHaveBeenCalled()
  })

  it("a client with no Contact gets one: the changed address carries the setter, what did not change carries none", async () => {
    const none = tx(null)
    await syncClientContactChannels(none.db, { ...scope, setByStaffUserId: "u9", before: { email: "a@x.invalid", whatsapp: "+26658000001" }, after: { email: "b@x.invalid", whatsapp: "+26658000001" } })
    expect(none.contactCreate).toHaveBeenCalledTimes(1)
    const rows = none.create.mock.calls.map((call) => (call[0] as { data: { channel: string; value: string; setByStaffUserId?: string | null } }).data)
    expect(rows.find((r) => r.channel === "EMAIL")).toMatchObject({ value: "b@x.invalid", setByStaffUserId: "u9" })
    expect(rows.find((r) => r.channel === "WHATSAPP")?.setByStaffUserId).toBeUndefined()
    expect(rows.find((r) => r.channel === "SMS")?.setByStaffUserId).toBeUndefined()
  })

  it("a staff address another Contact holds marks the Contact, and a later resolved change clears it", async () => {
    const held = tx(contact, { id: "i2", contactId: "someone-else" })
    await syncClientContactChannels(held.db, { ...scope, setByStaffUserId: "u9", before: { email: "old@x.invalid" }, after: { email: "taken@x.invalid" } })
    expect(held.update).toHaveBeenCalledWith({ where: { id: "ct1" }, data: { staffAddressUnresolvedAt: expect.any(Date) } })
    const cleared = tx({ ...contact, staffAddressUnresolvedAt: new Date() })
    await syncClientContactChannels(cleared.db, { ...scope, setByStaffUserId: "u9", before: { email: "taken@x.invalid" }, after: { email: "free@x.invalid" } })
    expect(cleared.update).toHaveBeenCalledWith({ where: { id: "ct1" }, data: { staffAddressUnresolvedAt: null } })
    const own = tx(contact, { id: "i2", contactId: "someone-else" })
    await syncClientContactChannels(own.db, { ...scope, before: { email: "old@x.invalid" }, after: { email: "taken@x.invalid" } })
    expect(own.update).not.toHaveBeenCalledWith({ where: { id: "ct1" }, data: { staffAddressUnresolvedAt: expect.any(Date) } })
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
