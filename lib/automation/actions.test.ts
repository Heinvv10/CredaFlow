/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"

const findLenderIdentityMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/config/identity", async (orig) => {
  const actual = await orig<typeof import("@/lib/config/identity")>()
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  findLenderIdentityMock.mockResolvedValue(actual.parseLenderIdentity(VALID_LENDER_COLUMNS))
  return { ...actual, findLenderIdentity: (...args: unknown[]) => findLenderIdentityMock(...args) }
})
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findFirst: vi.fn() },
    repaymentSchedule: { findFirst: vi.fn() },
    contact: { findFirst: vi.fn() },
    message: { findUnique: vi.fn() },
  },
}))
vi.mock("@/lib/messaging/send", () => {
  class MessageReconciliationRequiredError extends Error {
    messageRecord: unknown
    constructor(messageRecord: unknown) { super("reconciliation required"); this.messageRecord = messageRecord }
  }
  class KnownDispatchPersistenceError extends MessageReconciliationRequiredError {
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
    sendMessage: vi.fn(),
    SendBlockedError: class SendBlockedError extends Error {
      reason: string
      constructor(reason: string) { super(reason); this.reason = reason }
    },
    MessageReconciliationRequiredError,
    KnownDispatchPersistenceError,
    knownDispatchEvidenceFromError: (error: InstanceType<typeof KnownDispatchPersistenceError>) => ({
      outcome: error.outcome,
      ...(error.providerMessageId ? { providerMessageId: error.providerMessageId } : {}),
      ...(error.evidenceReference ? { evidenceReference: error.evidenceReference } : {}),
      ...(error.simulationReceiptId ? { simulationReceiptId: error.simulationReceiptId } : {}),
    }),
  }
})
vi.mock("@/lib/messaging/agent-message-template", () => ({
  getOrCreateAgentMessageTemplate: vi.fn(),
}))
vi.mock("@/lib/loan/charges-replay", () => ({ chargesOutstandingAt: vi.fn() }))

import { actionSendWa } from "./actions"
import { prisma } from "@/lib/prisma"
import {
  KnownDispatchPersistenceError,
  MessageReconciliationRequiredError,
  sendMessage,
  SendBlockedError,
} from "@/lib/messaging/send"
import { getOrCreateAgentMessageTemplate } from "@/lib/messaging/agent-message-template"
import { chargesOutstandingAt } from "@/lib/loan/charges-replay"

const rule = { id: "rule1", name: "7d overdue", description: null, actionConfig: { templateKey: "payment_overdue_7d" } }
const dispatchOptions = { occurrenceKey: "dpd_threshold:window:123" }

const loanRow = {
  reference: "LN-1",
  arrearsAmount: 100_00,
  client: {
    id: "c1", firstName: "A", lastName: "B", phone: "+27821111111", whatsapp: null,
  },
}

const contact = { id: "ct1", primaryWaJid: "27821111111@s.whatsapp.net", primaryPhone: "27821111111" }

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.clearAllMocks()
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})
  vi.mocked(prisma.loan.findFirst).mockResolvedValue(loanRow as any)
  vi.mocked(prisma.contact.findFirst).mockResolvedValue(contact as any)
  vi.mocked(getOrCreateAgentMessageTemplate).mockResolvedValue({ id: "tpl1" } as any)
  vi.mocked(sendMessage).mockResolvedValue({ id: "m1", status: "SENT", dispatchState: "ACCEPTED" } as any)
  vi.mocked(prisma.message.findUnique).mockResolvedValue(null)
  vi.mocked(chargesOutstandingAt).mockResolvedValue(0)
})

// Default charges: the
// amount quoted includes default charges outstanding; 0 while the flag is off.
describe("actionSendWa — default charges", () => {
  const scheduleRow = {
    loanId: "L9",
    dueDate: new Date("2026-08-01"),
    totalDue: 1000_00,
    totalPaid: 0,
    loan: { reference: "LN-SCHED-9", client: { id: "c1", firstName: "A", lastName: "B", phone: "+27821111111", whatsapp: null } },
  }
  const body = () => vi.mocked(sendMessage).mock.calls[0][0].vars.body as string

  it("loan overdue notice quotes arrears + charges", async () => {
    vi.mocked(chargesOutstandingAt).mockResolvedValue(50_00)
    await actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)
    expect(chargesOutstandingAt).toHaveBeenCalledWith(expect.anything(), { tenantId: "t1", loanId: "L1" }, expect.any(Date))
    expect(body()).toContain("Outstanding: *R\u00a0150,00*")
  })

  it("loan overdue notice quotes the lender's collections number", async () => {
    await actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)
    expect(body()).toContain("+27 11 000 0001")
  })

  it("loan overdue notice is not sent without a configured lender identity", async () => {
    findLenderIdentityMock.mockResolvedValueOnce(null)
    const result = await actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)
    expect(result).toMatchObject({ outcome: "failed", detail: "lender_identity_not_configured" })
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("loan overdue notice, flag off: amount unchanged", async () => {
    await actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)
    expect(body()).toContain("Outstanding: *R\u00a0100,00*")
  })

  it("schedule due notice quotes the unpaid instalment + charges", async () => {
    vi.mocked(prisma.repaymentSchedule.findFirst).mockResolvedValue(scheduleRow as any)
    vi.mocked(chargesOutstandingAt).mockResolvedValue(123_45)
    await actionSendWa({ ...rule, actionConfig: { templateKey: "payment_due_3d" } }, { type: "schedule", id: "S1" }, "t1", dispatchOptions)
    expect(chargesOutstandingAt).toHaveBeenCalledWith(expect.anything(), { tenantId: "t1", loanId: "L9" }, expect.any(Date))
    expect(body()).toContain("A payment of *R\u00a01\u00a0123,45*")
  })

  it("schedule due notice, flag off: amount unchanged", async () => {
    vi.mocked(prisma.repaymentSchedule.findFirst).mockResolvedValue(scheduleRow as any)
    await actionSendWa({ ...rule, actionConfig: { templateKey: "payment_due_3d" } }, { type: "schedule", id: "S1" }, "t1", dispatchOptions)
    expect(body()).toContain("A payment of *R\u00a01\u00a0000,00*")
  })
})

describe("actionSendWa", () => {
  it("routes through sendMessage(), no direct provider call, using the Contact's WA identity", async () => {
    const result = await actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "ct1",
        channel: "WHATSAPP",
        toValue: "27821111111@s.whatsapp.net",
        category: "automation_wa",
        idempotencyKey: "automation-wa:rule1:loan:L1:payment_overdue_7d:dpd_threshold:window:123",
      }),
    )
    expect(result).toEqual({
      outcome: "sent",
      messageId: "m1",
      dispatchPhase: "PROVIDER_ACCEPTED",
    })
  })

  it("loan lookup is scoped by tenantId in the query itself", async () => {
    await actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)
    expect(prisma.loan.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "L1", tenantId: "t1", OR: [{ clientId: null }, { client: { tenantId: "t1" } }] } }))
  })

  it("schedule lookup is scoped by the loan's tenantId in the query itself", async () => {
    vi.mocked(prisma.repaymentSchedule.findFirst).mockResolvedValue(null)
    await actionSendWa({ ...rule, actionConfig: { templateKey: "payment_due_3d" } }, { type: "schedule", id: "S1" }, "t1", dispatchOptions)
    expect(prisma.repaymentSchedule.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "S1", tenantId: "t1", loan: { tenantId: "t1", OR: [{ clientId: null }, { client: { tenantId: "t1" } }] } } }))
  })

  it("cross-tenant loan (not found under the tenant filter): no-ops before resolving a Contact", async () => {
    vi.mocked(prisma.loan.findFirst).mockResolvedValue(null)

    const result = await actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)

    expect(result).toEqual({ outcome: "failed", dispatchPhase: "PRE_RESERVATION", detail: "entity_not_found_or_cross_tenant" })
    expect(prisma.contact.findFirst).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("no Contact for the client: fails closed, logs loudly, does not send", async () => {
    vi.mocked(prisma.contact.findFirst).mockResolvedValue(null)

    const result = await actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)

    expect(result).toEqual({ outcome: "failed", dispatchPhase: "PRE_RESERVATION", detail: "contact_missing" })
    expect(sendMessage).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("no Contact"))
  })

  it("Contact has no WhatsApp/phone identity at all: fails closed, logs loudly", async () => {
    vi.mocked(prisma.contact.findFirst).mockResolvedValue({ id: "ct1", primaryWaJid: null, primaryPhone: null } as any)
    vi.mocked(prisma.loan.findFirst).mockResolvedValue({
      ...loanRow,
      client: { ...loanRow.client, phone: "", whatsapp: null },
    } as any)

    await actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)

    expect(sendMessage).not.toHaveBeenCalled()
  })

  it("eligibility block: logs loudly, does not throw", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new SendBlockedError("CHANNEL_OPTED_OUT"))

    await expect(actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)).resolves.toEqual({
      outcome: "blocked",
      dispatchPhase: "PRE_RESERVATION",
      detail: "CHANNEL_OPTED_OUT",
    })
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("blocked"))
  })

  it("dispatch failure: logs loudly, does not throw", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new Error("provider down"))
    vi.mocked(prisma.message.findUnique).mockResolvedValue({
      id: "m-rejected",
      status: "FAILED_PERMANENT",
      dispatchState: "DEFINITELY_REJECTED",
    } as any)

    await expect(actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)).resolves.toEqual({
      outcome: "failed",
      messageId: "m-rejected",
      dispatchPhase: "DEFINITELY_REJECTED",
      detail: "message_dispatch_failed",
    })
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("send failed"), expect.any(Error))
  })

  it("ambiguous dispatch logs do-not-replay reconciliation guidance", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new MessageReconciliationRequiredError({ id: "m-ambiguous" } as any))

    await expect(actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)).resolves.toEqual({
      outcome: "reconciliation_required",
      messageId: "m-ambiguous",
      dispatchPhase: "RECONCILIATION_REQUIRED",
    })

    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/reconciliation required.*automatic replay blocked/))
  })

  it("preserves known provider evidence while blocking automatic replay", async () => {
    vi.mocked(sendMessage).mockRejectedValue(new KnownDispatchPersistenceError({
      messageRecord: { id: "m-known" },
      outcome: "SIMULATED",
      simulationReceiptId: "dry-run-known",
    } as any))

    await expect(actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)).resolves.toEqual({
      outcome: "reconciliation_required",
      messageId: "m-known",
      dispatchPhase: "RECONCILIATION_REQUIRED",
      knownDispatchEvidence: {
        outcome: "SIMULATED",
        simulationReceiptId: "dry-run-known",
      },
    })
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/known provider evidence.*automatic replay blocked/))
  })

  it("schedule entity: resolves the Contact via the schedule's loan.client.id", async () => {
    vi.mocked(prisma.repaymentSchedule.findFirst).mockResolvedValue({
      dueDate: new Date("2026-08-01"),
      totalDue: 1000_00,
      totalPaid: 0,
      loan: { reference: "LN-SCHED-9", client: { id: "c1", firstName: "A", lastName: "B", phone: "+27821111111", whatsapp: null } },
    } as any)

    await actionSendWa(
      { ...rule, actionConfig: { templateKey: "payment_due_3d" } },
      { type: "schedule", id: "S1" },
      "t1",
      dispatchOptions,
    )

    expect(prisma.contact.findFirst).toHaveBeenCalledWith({ where: { tenantId: "t1", clientId: "c1" } })
    expect(sendMessage).toHaveBeenCalledTimes(1)
  })

  it("schedule payment_due_3d: the rendered WA body quotes the loan reference", async () => {
    vi.mocked(prisma.repaymentSchedule.findFirst).mockResolvedValue({
      dueDate: new Date("2026-08-01"),
      totalDue: 1000_00,
      totalPaid: 0,
      loan: { reference: "LN-SCHED-9", client: { id: "c1", firstName: "A", lastName: "B", phone: "+27821111111", whatsapp: null } },
    } as any)

    await actionSendWa(
      { ...rule, actionConfig: { templateKey: "payment_due_3d" } },
      { type: "schedule", id: "S1" },
      "t1",
      dispatchOptions,
    )

    expect(sendMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        vars: { body: expect.stringContaining("LN-SCHED-9") },
      }),
    )
  })

  it("unknown template key: no-ops before touching prisma", async () => {
    await expect(actionSendWa(
      { ...rule, actionConfig: { templateKey: "not_a_real_key" } },
      { type: "loan", id: "L1" },
      "t1",
      dispatchOptions,
    )).resolves.toEqual({ outcome: "failed", dispatchPhase: "PRE_RESERVATION", detail: "invalid_template" })

    expect(prisma.loan.findFirst).not.toHaveBeenCalled()
    expect(sendMessage).not.toHaveBeenCalled()
  })

  it.each([
    ["SIMULATED", "SIMULATED", "simulated", "SIMULATED"],
    ["RETRYING", "DISPATCHING", "pending", "RESERVED_PENDING"],
    ["FAILED_PERMANENT", "DEFINITELY_REJECTED", "failed", "DEFINITELY_REJECTED"],
  ] as const)("returns a truthful %s Message outcome", async (status, dispatchState, outcome, dispatchPhase) => {
    vi.mocked(sendMessage).mockResolvedValue({ id: "m-outcome", status, dispatchState } as any)

    await expect(actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)).resolves.toEqual({
      outcome,
      messageId: "m-outcome",
      dispatchPhase,
    })
  })

  it("classifies template preparation failure as pre-reservation", async () => {
    vi.mocked(getOrCreateAgentMessageTemplate).mockRejectedValue(new Error("template store unavailable"))

    await expect(actionSendWa(rule, { type: "loan", id: "L1" }, "t1", dispatchOptions)).resolves.toEqual({
      outcome: "failed",
      dispatchPhase: "PRE_RESERVATION",
      detail: "message_dispatch_failed_before_reservation",
    })
    expect(prisma.message.findUnique).toHaveBeenCalled()
  })
})
