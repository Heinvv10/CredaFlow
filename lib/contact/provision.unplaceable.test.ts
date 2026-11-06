import { afterEach, describe, expect, it, vi } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { provisionContactForClient, provisionContactForLead, resolveContactForLeadConversion } from "./provision"

// A number normalisePhone cannot place ("" from lib/contact/identity.ts: a foreign number,
// or a local "0…" one while no jurisdiction is loaded) is stored as no number (null), never
// as "": a "" primaryPhone looks like a value to every reader and matches nothing.
function makeTx() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    client: { findFirst: vi.fn().mockResolvedValue({ deceasedAt: null }) },
    contact: {
      findFirst: vi.fn().mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: "ct1", tenantId: "tn1", status: "CLIENT" }),
      update: vi.fn().mockImplementation(async ({ data }: { data: object }) => ({ id: "ct-lead", tenantId: "tn1", ...data })),
    },
    contactIdentity: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn() },
  }
}

afterEach(() => resetActiveJurisdiction())

describe("an unplaceable phone or WhatsApp number on a Contact", () => {
  it("a client's, with nothing loaded: null, and no identity row", async () => {
    const tx = makeTx()
    await provisionContactForClient(tx as never, { tenantId: "tn1", clientId: "cli1", phone: "0712345678", whatsapp: "0712345678" })
    const data = tx.contact.create.mock.calls[0][0].data
    expect(data.primaryPhone).toBeNull()
    expect(data.primaryWaJid).toBeNull()
    expect(tx.contactIdentity.create).not.toHaveBeenCalled()
  })

  it("a lead's foreign number under a loaded ZA lender: null", async () => {
    setActiveJurisdiction({ jurisdiction: "ZA", currency: "ZAR" })
    const tx = makeTx()
    await provisionContactForLead(tx as never, { tenantId: "tn1", leadId: "ld1", phone: "+14155550100", whatsapp: "+14155550100" })
    const data = tx.contact.create.mock.calls[0][0].data
    expect(data.primaryPhone).toBeNull()
    expect(data.primaryWaJid).toBeNull()
  })

  it("a converted lead's: a new Contact gets null, a promoted one has its number cleared to null", async () => {
    const created = makeTx()
    await resolveContactForLeadConversion(created as never, { tenantId: "tn1", leadId: "ld1", clientId: "cli1", phone: "0712345678", whatsapp: "0712345678" })
    expect(created.contact.create.mock.calls[0][0].data).toMatchObject({ primaryPhone: null, primaryWaJid: null })

    const promoted = makeTx()
    promoted.contact.findFirst
      .mockResolvedValueOnce({ id: "ct-lead", tenantId: "tn1", leadId: "ld1", clientId: null, status: "LEAD", primaryPhone: "27821234567", primaryWaJid: "27821234567@s.whatsapp.net" })
      .mockResolvedValueOnce(null)
    await resolveContactForLeadConversion(promoted as never, { tenantId: "tn1", leadId: "ld1", clientId: "cli1", phone: "0712345678", whatsapp: "0712345678" })
    expect(promoted.contact.update.mock.calls[0][0].data).toMatchObject({ primaryPhone: null, primaryWaJid: null })
  })

  it("a placeable number is stored as before", async () => {
    setActiveJurisdiction({ jurisdiction: "ZA", currency: "ZAR" })
    const tx = makeTx()
    tx.contactIdentity.create.mockResolvedValue({ id: "i1" })
    await provisionContactForClient(tx as never, { tenantId: "tn1", clientId: "cli1", phone: "0821234567", whatsapp: "0821234567" })
    expect(tx.contact.create.mock.calls[0][0].data).toMatchObject({ primaryPhone: "27821234567", primaryWaJid: "27821234567@s.whatsapp.net" })
  })
})
