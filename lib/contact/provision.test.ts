import { describe, it, expect, vi, beforeEach } from "vitest"
import { Prisma, type Contact, type ContactIdentity } from "@prisma/client"
import {
  ContactPromotionConflictError,
  resolveContactForLeadConversion,
  provisionContactForClient,
  provisionContactForLead,
} from "./provision"

interface MockTx {
  $queryRaw: ReturnType<typeof vi.fn>
  client: { findFirst: ReturnType<typeof vi.fn> }
  contact: {
    findFirst: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
    update: ReturnType<typeof vi.fn>
  }
  contactIdentity: {
    findFirst: ReturnType<typeof vi.fn>
    create: ReturnType<typeof vi.fn>
  }
}

function makeTx(): MockTx {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    client: { findFirst: vi.fn().mockResolvedValue({ deceasedAt: null }) },
    contact: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    contactIdentity: { findFirst: vi.fn(), create: vi.fn() },
  }
}

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: "c1",
    tenantId: "tn1",
    clientId: "cli1",
    leadId: null,
    firstName: "A",
    lastName: "B",
    primaryEmail: null,
    primaryPhone: null,
    primaryWaJid: null,
    status: "CLIENT",
    ...overrides,
  } as Contact
}

function makeIdentity(overrides: Partial<ContactIdentity> = {}): ContactIdentity {
  return {
    id: "i1",
    tenantId: "tn1",
    contactId: "c1",
    channel: "EMAIL",
    value: "x@y.com",
    verified: false,
    source: "APPLICATION_FORM",
    createdAt: new Date(),
    ...overrides,
  } as ContactIdentity
}

describe("provisionContactForClient", () => {
  let tx: MockTx
  beforeEach(() => {
    tx = makeTx()
  })

  it("creates a new Contact + identity rows when neither exists", async () => {
    tx.contact.findFirst.mockResolvedValue(null)
    tx.contact.create.mockResolvedValue(makeContact())
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contactIdentity.create
      .mockResolvedValueOnce(makeIdentity({ channel: "EMAIL", value: "x@y.com" }))
      .mockResolvedValueOnce(makeIdentity({ channel: "SMS", value: "27821234567" }))
      .mockResolvedValueOnce(makeIdentity({ channel: "WHATSAPP", value: "27821234567@s.whatsapp.net" }))

    const result = await provisionContactForClient(tx as never, {
      tenantId: "tn1",
      clientId: "cli1",
      firstName: "A",
      lastName: "B",
      email: "X@Y.COM",
      phone: "0821234567",
      whatsapp: "0821234567",
    })

    expect(tx.contact.create).toHaveBeenCalledOnce()
    expect(result.createdIdentities).toHaveLength(3)
    expect(result.preExistingIdentities).toHaveLength(0)
    expect(tx.contact.create.mock.calls[0][0].data.status).toBe("CLIENT")
    // primaryEmail must be normalised
    expect(tx.contact.create.mock.calls[0][0].data.primaryEmail).toBe("x@y.com")
    expect(tx.contact.create.mock.calls[0][0].data.primaryPhone).toBe("27821234567")
    expect(tx.contact.create.mock.calls[0][0].data.primaryWaJid).toBe("27821234567@s.whatsapp.net")
  })

  it("creates the Contact of an already-deceased client BLOCKED, with the death's marker", async () => {
    tx.contact.findFirst.mockResolvedValue(null)
    tx.client.findFirst.mockResolvedValue({ deceasedAt: new Date("2026-09-01T00:00:00Z") })
    tx.contact.create.mockResolvedValue(makeContact({ status: "BLOCKED" }))
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contactIdentity.create.mockResolvedValue(makeIdentity())

    await provisionContactForClient(tx as never, { tenantId: "tn1", clientId: "cli1", email: "x@y.com" })

    expect(tx.client.findFirst).toHaveBeenCalledWith({ where: { id: "cli1", tenantId: "tn1" }, select: { deceasedAt: true } })
    expect(tx.contact.create.mock.calls[0][0].data).toMatchObject({
      status: "BLOCKED", blockedReason: "DECEASED: client death recorded", blockedAt: expect.any(Date),
    })
  })

  it("does not look the client up, or change anything, when the Contact already exists", async () => {
    tx.contact.findFirst.mockResolvedValue(makeContact())
    tx.contactIdentity.findFirst.mockResolvedValue(makeIdentity())

    await provisionContactForClient(tx as never, { tenantId: "tn1", clientId: "cli1", email: "x@y.com" })

    expect(tx.client.findFirst).not.toHaveBeenCalled()
    expect(tx.contact.create).not.toHaveBeenCalled()
  })

  it("reuses an existing Contact and only creates missing identity rows", async () => {
    tx.contact.findFirst.mockResolvedValue(makeContact())
    // Email identity already exists; SMS missing
    tx.contactIdentity.findFirst
      .mockResolvedValueOnce(makeIdentity({ channel: "EMAIL", value: "x@y.com" }))
      .mockResolvedValueOnce(null)
    tx.contactIdentity.create.mockResolvedValueOnce(makeIdentity({ channel: "SMS", value: "27821234567" }))

    const result = await provisionContactForClient(tx as never, {
      tenantId: "tn1",
      clientId: "cli1",
      email: "x@y.com",
      phone: "0821234567",
    })

    expect(tx.contact.create).not.toHaveBeenCalled()
    expect(result.createdIdentities).toHaveLength(1)
    expect(result.createdIdentities[0].channel).toBe("SMS")
    expect(result.preExistingIdentities).toHaveLength(1)
  })

  it("skips channels with empty/unparseable values silently", async () => {
    tx.contact.findFirst.mockResolvedValue(null)
    tx.contact.create.mockResolvedValue(makeContact())

    const result = await provisionContactForClient(tx as never, {
      tenantId: "tn1",
      clientId: "cli1",
      email: "  ", // whitespace-only — normaliseEmail returns "" → falsy in collector
      phone: "abc", // non-phone characters — normalisePhone returns ""
      whatsapp: undefined,
    })

    // Email "  " trims to "" which is falsy → skipped before normalisation kicks in.
    // Phone returns "" from normalisePhone → skipped by collector.
    expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    expect(result.createdIdentities).toHaveLength(0)
  })

  it("uses APPLICATION_FORM source by default; honours override", async () => {
    tx.contact.findFirst.mockResolvedValue(null)
    tx.contact.create.mockResolvedValue(makeContact())
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contactIdentity.create.mockResolvedValue(makeIdentity())

    await provisionContactForClient(tx as never, {
      tenantId: "tn1",
      clientId: "cli1",
      email: "x@y.com",
      source: "MANUAL",
    })

    expect(tx.contactIdentity.create.mock.calls[0][0].data.source).toBe("MANUAL")
  })

  it("idempotent: second invocation with same input creates nothing new", async () => {
    tx.contact.findFirst.mockResolvedValue(makeContact())
    tx.contactIdentity.findFirst.mockResolvedValue(makeIdentity())

    const result = await provisionContactForClient(tx as never, {
      tenantId: "tn1",
      clientId: "cli1",
      email: "x@y.com",
      phone: "0821234567",
    })

    expect(tx.contact.create).not.toHaveBeenCalled()
    expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    expect(result.createdIdentities).toHaveLength(0)
    expect(result.preExistingIdentities.length).toBeGreaterThan(0)
  })
})

describe("provisionContactForLead", () => {
  let tx: MockTx
  beforeEach(() => {
    tx = makeTx()
  })

  it("creates a LEAD-status Contact keyed on leadId + identity rows", async () => {
    tx.contact.findFirst.mockResolvedValue(null)
    tx.contact.create.mockResolvedValue(makeContact({ clientId: null, leadId: "ld1", status: "LEAD" }))
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contactIdentity.create
      .mockResolvedValueOnce(makeIdentity({ channel: "EMAIL", value: "x@y.com" }))
      .mockResolvedValueOnce(makeIdentity({ channel: "SMS", value: "27821234567" }))

    const result = await provisionContactForLead(tx as never, {
      tenantId: "tn1",
      leadId: "ld1",
      firstName: "A",
      lastName: "B",
      email: "X@Y.COM",
      phone: "0821234567",
    })

    expect(tx.contact.create).toHaveBeenCalledOnce()
    const data = tx.contact.create.mock.calls[0][0].data
    expect(data.leadId).toBe("ld1")
    expect(data.clientId).toBeUndefined()
    expect(data.status).toBe("LEAD")
    expect(data.firstSeenContext).toBe("lead_create")
    expect(result.createdIdentities).toHaveLength(2)
  })

  it("defaults identity source to MANUAL", async () => {
    tx.contact.findFirst.mockResolvedValue(null)
    tx.contact.create.mockResolvedValue(makeContact({ clientId: null, leadId: "ld1", status: "LEAD" }))
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contactIdentity.create.mockResolvedValue(makeIdentity({ channel: "SMS", value: "27821234567" }))

    await provisionContactForLead(tx as never, {
      tenantId: "tn1",
      leadId: "ld1",
      phone: "0821234567",
    })

    expect(tx.contactIdentity.create.mock.calls[0][0].data.source).toBe("MANUAL")
  })

  it("skips an identity already owned by a different Contact (no throw, no create)", async () => {
    tx.contact.findFirst.mockResolvedValue(null)
    tx.contact.create.mockResolvedValue(makeContact({ id: "c2", clientId: null, leadId: "ld1", status: "LEAD" }))
    // Phone identity already claimed by another Contact (c1 ≠ created c2).
    tx.contactIdentity.findFirst.mockResolvedValue(
      makeIdentity({ id: "iX", contactId: "c1", channel: "SMS", value: "27821234567" }),
    )

    const result = await provisionContactForLead(tx as never, {
      tenantId: "tn1",
      leadId: "ld1",
      phone: "0821234567",
    })

    expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    expect(result.createdIdentities).toHaveLength(0)
    // Claimed elsewhere → not counted as ours.
    expect(result.preExistingIdentities).toHaveLength(0)
  })

  it("reuses an existing lead Contact (idempotent)", async () => {
    tx.contact.findFirst.mockResolvedValue(makeContact({ id: "c2", clientId: null, leadId: "ld1", status: "LEAD" }))
    tx.contactIdentity.findFirst.mockResolvedValue(
      makeIdentity({ id: "iOurs", contactId: "c2", channel: "SMS", value: "27821234567" }),
    )

    const result = await provisionContactForLead(tx as never, {
      tenantId: "tn1",
      leadId: "ld1",
      phone: "0821234567",
    })

    expect(tx.contact.create).not.toHaveBeenCalled()
    expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    expect(result.preExistingIdentities).toHaveLength(1)
  })
})

describe("resolveContactForLeadConversion", () => {
  let tx: MockTx
  beforeEach(() => {
    tx = makeTx()
  })

  it("promotes the normal lead Contact in place and retains its identities", async () => {
    const leadContact = makeContact({
      id: "contact-lead",
      clientId: null,
      leadId: "lead-1",
      status: "LEAD",
    })
    tx.contact.findFirst
      .mockResolvedValueOnce(leadContact)
      .mockResolvedValueOnce(null)
    tx.contact.update.mockResolvedValue({
      ...leadContact,
      clientId: "client-1",
      status: "CLIENT",
    })
    tx.contactIdentity.findFirst
      .mockResolvedValueOnce(makeIdentity({ contactId: "contact-lead", value: "x@y.com" }))
      .mockResolvedValueOnce(makeIdentity({ contactId: "contact-lead", channel: "SMS", value: "27821234567" }))

    const result = await resolveContactForLeadConversion(tx as never, {
      tenantId: "tn1",
      leadId: "lead-1",
      clientId: "client-1",
      firstName: "A",
      lastName: "B",
      email: "x@y.com",
      phone: "0821234567",
    })

    expect(tx.contact.create).not.toHaveBeenCalled()
    expect(tx.contact.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "contact-lead" },
      data: expect.objectContaining({
        leadId: "lead-1",
        clientId: "client-1",
        status: "CLIENT",
      }),
    }))
    expect(result.preExistingIdentities).toHaveLength(2)
    expect(result.created).toBe(false)
    expect(result.resolution).toBe("PROMOTED_LEAD_CONTACT")
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2)
    expect(tx.$queryRaw.mock.invocationCallOrder[1]).toBeLessThan(
      tx.contact.findFirst.mock.invocationCallOrder[0],
    )
  })

  it("creates one dual-linked Contact if directory provisioning never ran", async () => {
    tx.contact.findFirst.mockResolvedValue(null)
    tx.contact.create.mockResolvedValue(makeContact({
      id: "contact-new",
      clientId: "client-1",
      leadId: "lead-1",
      status: "CLIENT",
    }))
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contactIdentity.create.mockResolvedValue(makeIdentity({ contactId: "contact-new" }))

    const result = await resolveContactForLeadConversion(tx as never, {
      tenantId: "tn1",
      leadId: "lead-1",
      clientId: "client-1",
      email: "x@y.com",
    })

    expect(tx.contact.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ leadId: "lead-1", clientId: "client-1" }),
    }))
    expect(result.created).toBe(true)
    expect(result.resolution).toBe("CREATED_CONTACT")
  })

  it("fails closed when separate lead and client Contacts require an audited merge", async () => {
    tx.contact.findFirst
      .mockResolvedValueOnce(makeContact({ id: "contact-lead", clientId: null, leadId: "lead-1" }))
      .mockResolvedValueOnce(makeContact({ id: "contact-client", clientId: "client-1", leadId: null }))

    await expect(resolveContactForLeadConversion(tx as never, {
      tenantId: "tn1",
      leadId: "lead-1",
      clientId: "client-1",
    })).rejects.toBeInstanceOf(ContactPromotionConflictError)
    expect(tx.contact.update).not.toHaveBeenCalled()
  })

  it("reuses a repeat Client's canonical Contact without replacing its earlier lead link", async () => {
    const clientContact = makeContact({
      id: "contact-client",
      clientId: "client-1",
      leadId: "lead-earlier",
      status: "CLIENT",
    })
    tx.contact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(clientContact)

    const result = await resolveContactForLeadConversion(tx as never, {
      tenantId: "tn1",
      leadId: "lead-repeat",
      clientId: "client-1",
      email: "repeat@example.test",
      reuseExistingClientContact: true,
    })

    expect(result.contact).toBe(clientContact)
    expect(result.resolution).toBe("REUSED_CLIENT_CONTACT")
    expect(result.previous).toEqual({
      clientId: "client-1",
      leadId: "lead-earlier",
      status: "CLIENT",
      primaryEmail: null,
      primaryPhone: null,
      primaryWaJid: null,
    })
    expect(tx.contact.update).not.toHaveBeenCalled()
    expect(tx.contact.create).not.toHaveBeenCalled()
    expect(tx.contactIdentity.findFirst).not.toHaveBeenCalled()
  })

  it("reconciles current identities on website reuse without replacing the representative Lead", async () => {
    const clientContact = makeContact({
      id: "contact-client",
      clientId: "client-1",
      leadId: "lead-earlier",
      status: "CLIENT",
      primaryPhone: "27820000000",
    })
    tx.contact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(clientContact)
    tx.contact.update.mockResolvedValue({
      ...clientContact,
      primaryPhone: "27821234567",
    })
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contactIdentity.create.mockResolvedValue(
      makeIdentity({
        id: "identity-new-phone",
        contactId: "contact-client",
        channel: "SMS",
        value: "27821234567",
      }),
    )

    const result = await resolveContactForLeadConversion(tx as never, {
      tenantId: "tn1",
      leadId: "lead-repeat",
      clientId: "client-1",
      phone: "0821234567",
      reuseExistingClientContact: true,
      reconcileIdentitiesOnReuse: true,
    })

    expect(tx.contact.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "contact-client" },
      data: expect.not.objectContaining({ leadId: expect.anything() }),
    }))
    expect(tx.contactIdentity.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: "tn1",
        channel: "SMS",
        value: "27821234567",
      },
    })
    expect(result.contact.leadId).toBe("lead-earlier")
    expect(result.resolution).toBe("REUSED_CLIENT_CONTACT")
    expect(result.createdIdentities).toEqual([
      expect.objectContaining({ id: "identity-new-phone" }),
    ])
  })

  it.each(["BLOCKED", "SPAM", "DORMANT", "UNKNOWN"] as const)(
    "preserves an existing %s Contact status during conversion",
    async (status) => {
      const leadContact = makeContact({
        id: "contact-lead",
        clientId: null,
        leadId: "lead-1",
        status,
      })
      tx.contact.findFirst
        .mockResolvedValueOnce(leadContact)
        .mockResolvedValueOnce(null)
      tx.contact.update.mockResolvedValue({
        ...leadContact,
        clientId: "client-1",
        status,
      })

      const result = await resolveContactForLeadConversion(tx as never, {
        tenantId: "tn1",
        leadId: "lead-1",
        clientId: "client-1",
      })

      expect(tx.contact.update).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status }),
      }))
      expect(result.contact.status).toBe(status)
    },
  )

  it.each(["MERGED", "STAFF"] as const)(
    "fails closed instead of converting an archived/staff %s Contact",
    async (status) => {
      tx.contact.findFirst
        .mockResolvedValueOnce(makeContact({
          id: "contact-protected",
          clientId: null,
          leadId: "lead-1",
          status,
        }))
        .mockResolvedValueOnce(null)

      await expect(resolveContactForLeadConversion(tx as never, {
        tenantId: "tn1",
        leadId: "lead-1",
        clientId: "client-1",
      })).rejects.toMatchObject({
        name: "ContactPromotionConflictError",
        reason: "CONTACT_STATUS_NOT_CONVERTIBLE",
      })
      expect(tx.contact.update).not.toHaveBeenCalled()
      expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    },
  )

  it("fails with a typed conflict when the submitted identity already belongs to another Contact", async () => {
    const leadContact = makeContact({
      id: "contact-lead",
      clientId: null,
      leadId: "lead-1",
      status: "LEAD",
    })
    tx.contact.findFirst
      .mockResolvedValueOnce(leadContact)
      .mockResolvedValueOnce(null)
    tx.contact.update.mockResolvedValue({
      ...leadContact,
      clientId: "client-1",
      status: "CLIENT",
    })
    tx.contactIdentity.findFirst.mockResolvedValue(
      makeIdentity({ id: "identity-other", contactId: "contact-other" }),
    )

    await expect(resolveContactForLeadConversion(tx as never, {
      tenantId: "tn1",
      leadId: "lead-1",
      clientId: "client-1",
      email: "x@y.com",
    })).rejects.toMatchObject({
      name: "ContactPromotionConflictError",
      reason: "IDENTITY_OWNED_ELSEWHERE",
    })
    expect(tx.contactIdentity.create).not.toHaveBeenCalled()
  })

  it("maps a cross-Client identity insertion race to the same typed conflict", async () => {
    const leadContact = makeContact({
      id: "contact-lead",
      clientId: null,
      leadId: "lead-1",
      status: "LEAD",
    })
    tx.contact.findFirst
      .mockResolvedValueOnce(leadContact)
      .mockResolvedValueOnce(null)
    tx.contact.update.mockResolvedValue({
      ...leadContact,
      clientId: "client-1",
      status: "CLIENT",
    })
    tx.contactIdentity.findFirst.mockResolvedValue(null)
    tx.contactIdentity.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("identity collision", {
        code: "P2002",
        clientVersion: "test",
        meta: { target: ["tenantId", "channel", "value"] },
      }),
    )

    await expect(resolveContactForLeadConversion(tx as never, {
      tenantId: "tn1",
      leadId: "lead-1",
      clientId: "client-1",
      email: "x@y.com",
    })).rejects.toMatchObject({
      name: "ContactPromotionConflictError",
      reason: "IDENTITY_OWNED_ELSEWHERE",
    })
  })

  it("links an unattributed Client Contact to its first completed Lead conversion", async () => {
    const clientContact = makeContact({
      id: "contact-client",
      clientId: "client-1",
      leadId: null,
      status: "CLIENT",
    })
    tx.contact.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(clientContact)
    tx.contact.update.mockResolvedValue({
      ...clientContact,
      leadId: "lead-first",
    })
    tx.contactIdentity.findFirst.mockResolvedValue(
      makeIdentity({ contactId: "contact-client", value: "x@y.com" }),
    )

    const result = await resolveContactForLeadConversion(tx as never, {
      tenantId: "tn1",
      leadId: "lead-first",
      clientId: "client-1",
      email: "x@y.com",
      reuseExistingClientContact: true,
    })

    expect(tx.contact.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: "contact-client" },
      data: expect.objectContaining({
        clientId: "client-1",
        leadId: "lead-first",
        status: "CLIENT",
      }),
    }))
    expect(result.contact.leadId).toBe("lead-first")
    expect(result.resolution).toBe("LINKED_CLIENT_CONTACT")
    expect(result.created).toBe(false)
  })

  it("reuses the Client Contact when a separate legacy Lead Contact also exists", async () => {
    const leadContact = makeContact({
      id: "contact-lead",
      clientId: null,
      leadId: "lead-repeat",
      status: "LEAD",
    })
    const clientContact = makeContact({
      id: "contact-client",
      clientId: "client-1",
      leadId: "lead-earlier",
      status: "CLIENT",
    })
    tx.contact.findFirst
      .mockResolvedValueOnce(leadContact)
      .mockResolvedValueOnce(clientContact)

    const result = await resolveContactForLeadConversion(tx as never, {
      tenantId: "tn1",
      leadId: "lead-repeat",
      clientId: "client-1",
      reuseExistingClientContact: true,
    })

    expect(result.contact).toBe(clientContact)
    expect(result.resolution).toBe("REUSED_CLIENT_CONTACT")
    expect(tx.contact.update).not.toHaveBeenCalled()
    expect(tx.contact.create).not.toHaveBeenCalled()
  })

  it.each(["MERGED", "STAFF"] as const)(
    "fails closed when a reusable Client Contact has a separate protected %s Lead Contact",
    async (status) => {
      tx.contact.findFirst
        .mockResolvedValueOnce(makeContact({
          id: "contact-protected-lead",
          clientId: null,
          leadId: "lead-repeat",
          status,
        }))
        .mockResolvedValueOnce(makeContact({
          id: "contact-client",
          clientId: "client-1",
          leadId: "lead-earlier",
          status: "CLIENT",
        }))

      await expect(resolveContactForLeadConversion(tx as never, {
        tenantId: "tn1",
        leadId: "lead-repeat",
        clientId: "client-1",
        reuseExistingClientContact: true,
      })).rejects.toMatchObject({
        name: "ContactPromotionConflictError",
        reason: "CONTACT_STATUS_NOT_CONVERTIBLE",
      })
      expect(tx.contact.update).not.toHaveBeenCalled()
      expect(tx.contactIdentity.create).not.toHaveBeenCalled()
    },
  )
})
