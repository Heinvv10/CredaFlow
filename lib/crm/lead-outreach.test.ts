/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

const leadFindFirstMock = vi.fn()
const contactFindFirstMock = vi.fn()
const templateUpsertMock = vi.fn()
const getCommsSettingsMock = vi.fn()
const getChannelAvailabilityMock = vi.fn()
const sendMessageMock = vi.fn()

// vi.mock factories are hoisted above module-scope declarations, so the error
// class the factory returns must be hoisted with them.
const {
  FakeSendBlockedError,
  FakeMessageReconciliationRequiredError,
  FakeKnownDispatchPersistenceError,
} = vi.hoisted(() => {
  class FakeSendBlockedError extends Error {
    reason: string
    constructor(reason: string) {
      super(reason)
      this.reason = reason
    }
  }
  class FakeMessageReconciliationRequiredError extends Error {
    messageRecord: unknown
    constructor(messageRecord: unknown) { super("reconciliation required"); this.messageRecord = messageRecord }
  }
  class FakeKnownDispatchPersistenceError extends FakeMessageReconciliationRequiredError {
    outcome: "PROVIDER_ACCEPTED" | "SIMULATED"
    providerMessageId?: string
    evidenceReference?: string
    simulationReceiptId?: string
    constructor(args: {
      messageRecord: unknown
      outcome: "PROVIDER_ACCEPTED" | "SIMULATED"
      providerMessageId?: string
      evidenceReference?: string
      simulationReceiptId?: string
    }) {
      super(args.messageRecord)
      this.outcome = args.outcome
      this.providerMessageId = args.providerMessageId
      this.evidenceReference = args.evidenceReference
      this.simulationReceiptId = args.simulationReceiptId
    }
  }
  return {
    FakeSendBlockedError,
    FakeMessageReconciliationRequiredError,
    FakeKnownDispatchPersistenceError,
  }
})

vi.mock("@/lib/prisma", () => ({
  prisma: {
    lead: { findFirst: (a: unknown) => leadFindFirstMock(a) },
    contact: { findFirst: (a: unknown) => contactFindFirstMock(a) },
    messageTemplate: { upsert: (a: unknown) => templateUpsertMock(a) },
  },
}))
vi.mock("@/lib/inbox/settings", () => ({ getCommsSettings: (t: string) => getCommsSettingsMock(t) }))
vi.mock("@/lib/messaging/channel-availability", () => ({
  getChannelAvailability: (a: unknown) => getChannelAvailabilityMock(a),
}))
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: (a: unknown) => sendMessageMock(a),
  SendBlockedError: FakeSendBlockedError,
  MessageReconciliationRequiredError: FakeMessageReconciliationRequiredError,
  KnownDispatchPersistenceError: FakeKnownDispatchPersistenceError,
  knownDispatchEvidenceFromError: (error: InstanceType<typeof FakeKnownDispatchPersistenceError>) => ({
    outcome: error.outcome,
    ...(error.providerMessageId ? { providerMessageId: error.providerMessageId } : {}),
    ...(error.evidenceReference ? { evidenceReference: error.evidenceReference } : {}),
    ...(error.simulationReceiptId ? { simulationReceiptId: error.simulationReceiptId } : {}),
  }),
}))

import { sendLeadOutreach, getOrCreateLeadOutreachTemplate, buildOutreachVars } from "./lead-outreach"

beforeEach(() => {
  vi.clearAllMocks()
  leadFindFirstMock.mockResolvedValue({ firstName: "Nomvula", status: "NEW", requestedAmount: 500_000, contact: { id: "ct1" } })
  contactFindFirstMock.mockResolvedValue({ id: "ct1", tenantId: "t1" })
  getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: true })
  getChannelAvailabilityMock.mockResolvedValue({
    WHATSAPP: { enabled: true, toValue: "+27821234567" },
    SMS: { enabled: true, toValue: "+27821234567" },
    EMAIL: { enabled: false, reason: "no email" },
  })
  templateUpsertMock.mockResolvedValue({ id: "tpl1", key: "lead_qualification_whatsapp", category: "SERVICE" })
  sendMessageMock.mockResolvedValue({ id: "m1", conversationId: "c1", status: "SENT" })
})

const base = {
  tenantId: "t1",
  leadId: "lead-1",
  kind: "QUALIFICATION" as const,
  channel: "WHATSAPP" as const,
  agentUserId: "u1",
  agentFullName: "Thabo Molefe",
  operationId: "11111111-1111-4111-8111-111111111111",
}

describe("sendLeadOutreach", () => {
  it("sends the bound template with the rendered vars", async () => {
    const r = await sendLeadOutreach(base)

    expect(r).toEqual({
      ok: true,
      messageId: "m1",
      conversationId: "c1",
      status: "SENT",
      outcome: "sent",
    })
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "ct1",
        channel: "WHATSAPP",
        template: expect.objectContaining({ id: "tpl1" }),
        vars: { firstName: "Nomvula", agentName: "Thabo" },
        toValue: "+27821234567",
        createdById: "u1",
        category: "lead_outreach",
        idempotencyKey: "lead-outreach:lead-1:QUALIFICATION:WHATSAPP:11111111-1111-4111-8111-111111111111",
      })
    )
  })

  it.each([
    ["RETRYING", "pending"],
    ["QUEUED", "pending"],
    ["FAILED_PERMANENT", "not_sent"],
    ["EXPIRED", "not_sent"],
    ["SIMULATED", "simulated"],
  ] as const)("projects an idempotent %s replay as %s", async (status, outcome) => {
    sendMessageMock.mockResolvedValue({ id: "m-replay", conversationId: "c1", status })

    await expect(sendLeadOutreach(base)).resolves.toMatchObject({
      ok: true,
      messageId: "m-replay",
      status,
      outcome,
    })
  })

  it("refuses a lead with no loan enquiry on file, server-side", async () => {
    // The UI hides the card, but a stale page or a direct API call must not be
    // able to send an unsolicited credit approach. See lead-outreach-eligibility.
    leadFindFirstMock.mockResolvedValue({ firstName: "Nomvula", status: "NEW", requestedAmount: null, contact: { id: "ct1" } })

    const r = await sendLeadOutreach(base)

    expect(r).toMatchObject({ ok: false, reason: "NOT_A_LOAN_ENQUIRY" })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it.each(["CONVERTED", "LOST"])("refuses a %s lead server-side, not just in the UI", async (status) => {
    // The race the client gate cannot close: the lead is converted while an
    // agent has the detail page open, then they click Re-engage.
    leadFindFirstMock.mockResolvedValue({ firstName: "Nomvula", status, requestedAmount: 500_000, contact: { id: "ct1" } })

    const r = await sendLeadOutreach(base)

    expect(r).toMatchObject({ ok: false, reason: "LEAD_CLOSED" })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("reads the fields the eligibility gate needs", async () => {
    await sendLeadOutreach(base)
    const arg = leadFindFirstMock.mock.calls[0][0]
    // Without these selected, leadOutreachEligibility silently sees undefined.
    expect(arg.select).toMatchObject({ status: true, requestedAmount: true })
  })

  it("scopes the lead and contact reads to the tenant", async () => {
    await sendLeadOutreach(base)

    expect(leadFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "lead-1", tenantId: "t1" } })
    )
    expect(contactFindFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "ct1", tenantId: "t1" } })
    )
  })

  it("refuses a lead with no contact record and never sends", async () => {
    leadFindFirstMock.mockResolvedValue({ firstName: "Nomvula", status: "NEW", requestedAmount: 500_000, contact: null })

    const r = await sendLeadOutreach(base)

    expect(r).toMatchObject({ ok: false, reason: "NO_CONTACT" })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("refuses a lead outside the tenant", async () => {
    leadFindFirstMock.mockResolvedValue(null)

    const r = await sendLeadOutreach(base)

    expect(r).toMatchObject({ ok: false, reason: "NO_CONTACT" })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("refuses when the contact vanishes between the two reads", async () => {
    // The lead carries a contact id but the second, tenant-scoped read finds
    // nothing: a ContactMerge or deletion landing between the two queries.
    // Real race, and the branch that would otherwise pass `contact` as
    // undefined into getChannelAvailability.
    contactFindFirstMock.mockResolvedValue(null)

    const r = await sendLeadOutreach(base)

    expect(r).toEqual({ ok: false, reason: "NO_CONTACT", detail: "contact not found" })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("refuses when the channel has no destination, surfacing the real reason", async () => {
    getChannelAvailabilityMock.mockResolvedValue({
      WHATSAPP: { enabled: false, reason: "contact opted out of WhatsApp" },
    })

    const r = await sendLeadOutreach(base)

    expect(r).toEqual({ ok: false, reason: "NO_DESTINATION", detail: "contact opted out of WhatsApp" })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("maps a consent block to SEND_BLOCKED rather than throwing", async () => {
    sendMessageMock.mockRejectedValue(new FakeSendBlockedError("CHANNEL_OPTED_OUT"))

    const r = await sendLeadOutreach(base)

    expect(r).toEqual({ ok: false, reason: "SEND_BLOCKED", detail: "CHANNEL_OPTED_OUT" })
  })

  it("maps an unexpected dispatch failure to SEND_FAILED without leaking the raw error", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {})
    sendMessageMock.mockRejectedValue(new Error("PROVIDER_KEY=sk_live_abc123 refused"))

    const r = await sendLeadOutreach(base)

    expect(r.ok).toBe(false)
    expect((r as any).reason).toBe("SEND_FAILED")
    expect((r as any).detail).not.toContain("sk_live")
  })

  it("preserves known provider evidence for the reconciliation workflow", async () => {
    sendMessageMock.mockRejectedValue(new FakeKnownDispatchPersistenceError({
      messageRecord: { id: "m-known", conversationId: "c1" },
      outcome: "PROVIDER_ACCEPTED",
      providerMessageId: "provider-known",
    }))

    await expect(sendLeadOutreach(base)).resolves.toEqual({
      ok: true,
      messageId: "m-known",
      conversationId: "c1",
      status: "RECONCILIATION_REQUIRED",
      outcome: "reconciliation_required",
      knownDispatchEvidence: {
        outcome: "PROVIDER_ACCEPTED",
        providerMessageId: "provider-known",
      },
    })
  })

  it("respects whatsappEnabled=false from tenant comms settings", async () => {
    getCommsSettingsMock.mockResolvedValue({ whatsappEnabled: false })
    await sendLeadOutreach(base)

    expect(getChannelAvailabilityMock).toHaveBeenCalledWith(
      expect.objectContaining({ whatsappEnabled: false })
    )
  })
})

describe("getOrCreateLeadOutreachTemplate — compliance pinning", () => {
  it("creates SERVICE, never statutoryOverride", async () => {
    await getOrCreateLeadOutreachTemplate("t1", "REENGAGE", "WHATSAPP")

    const arg = templateUpsertMock.mock.calls[0][0]
    expect(arg.where).toEqual({ tenantId_key: { tenantId: "t1", key: "lead_reengage_whatsapp" } })
    expect(arg.create).toMatchObject({
      tenantId: "t1",
      key: "lead_reengage_whatsapp",
      channel: "WHATSAPP",
      category: "SERVICE",
      // true would bypass channel opt-out — only s.129 / court process may.
      statutoryOverride: false,
      active: true,
    })
    expect(arg.create.body).toContain("{{firstName}}")
  })

  it("re-syncs body + category on update, so the code stays the source of truth", async () => {
    await getOrCreateLeadOutreachTemplate("t1", "QUALIFICATION", "WHATSAPP")

    const arg = templateUpsertMock.mock.calls[0][0]
    expect(arg.update).toMatchObject({ category: "SERVICE", statutoryOverride: false, active: true })
    expect(arg.update.body).toContain("loan enquiry")
  })

  it("cannot be flipped to a statutory override by a stale DB row", async () => {
    // An operator editing the row directly must not be able to grant these
    // templates opt-out bypass — every upsert re-pins it.
    for (const kind of ["QUALIFICATION", "REQUEST_DOCS", "REENGAGE"] as const) {
      templateUpsertMock.mockClear()
      await getOrCreateLeadOutreachTemplate("t1", kind, "WHATSAPP")
      const arg = templateUpsertMock.mock.calls[0][0]
      expect(arg.update.statutoryOverride).toBe(false)
      expect(arg.create.statutoryOverride).toBe(false)
    }
  })
})

describe("buildOutreachVars", () => {
  // Testing sanitiseOutreachVar in isolation proves nothing about the SEND
  // path — this pins that buildOutreachVars actually applies it. (Mutation
  // check: deleting the sanitiser call passed the whole suite until this
  // existed.)
  const SMISH = "Thabo\n\nAcme Lending: your payout is on hold, pay R250 to 123456789"

  it("sanitises the lead's public-form firstName before it reaches the body", () => {
    const vars = buildOutreachVars({ leadFirstName: SMISH, agentFullName: "Thabo Molefe" })
    expect(vars.firstName).not.toContain("\n")
    expect(vars.firstName).not.toContain("release")
    expect(vars.firstName).not.toContain("123456789")
  })

  it("sanitises the agent name too", () => {
    const vars = buildOutreachVars({ leadFirstName: "Nomvula", agentFullName: "Thabo\nPay here" })
    expect(vars.agentName).toBe("Thabo")
  })

  it("reduces the agent to a first name", () => {
    expect(buildOutreachVars({ leadFirstName: "Nomvula", agentFullName: "Pieter van der Merwe" })).toEqual({
      firstName: "Nomvula",
      agentName: "Pieter",
    })
  })

  it("handles a nameless staff account", () => {
    expect(buildOutreachVars({ leadFirstName: "Nomvula", agentFullName: null }).agentName).toBe("your consultant")
  })
})
