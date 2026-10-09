import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { NextRequest } from "next/server"
import type { Message } from "@prisma/client"

const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const loanFindUniqueMock = vi.fn()
const contactFindFirstMock = vi.fn()
const loanNoteCreateMock = vi.fn()
const logAuditMock = vi.fn()
const sendMessageMock = vi.fn()
const getOrCreateAgentMessageTemplateMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findUnique: (a: unknown) => loanFindUniqueMock(a) },
    contact: { findFirst: (a: unknown) => contactFindFirstMock(a) },
    loanNote: { create: (a: unknown) => loanNoteCreateMock(a) },
  },
}))
vi.mock("@/lib/messaging/send", () => {
  class MessageReconciliationRequiredError extends Error {
    messageRecord: { id: string }
    constructor(messageRecord: { id: string }) { super("reconciliation required"); this.messageRecord = messageRecord }
  }
  class KnownDispatchPersistenceError extends MessageReconciliationRequiredError {
    outcome: "PROVIDER_ACCEPTED" | "SIMULATED"
    providerMessageId?: string
    constructor(args: { message: { id: string }; outcome: "PROVIDER_ACCEPTED" | "SIMULATED"; providerMessageId?: string }) {
      super(args.message)
      this.outcome = args.outcome
      this.providerMessageId = args.providerMessageId
    }
  }
  return {
    sendMessage: (a: unknown) => sendMessageMock(a),
    SendBlockedError: class SendBlockedError extends Error {
      reason: string
      constructor(reason: string) { super(reason); this.reason = reason }
    },
    MessageReconciliationRequiredError,
    KnownDispatchPersistenceError,
    knownDispatchEvidenceFromError: (error: InstanceType<typeof KnownDispatchPersistenceError>) => ({
      outcome: error.outcome,
      ...(error.providerMessageId ? { providerMessageId: error.providerMessageId } : {}),
    }),
  }
})
vi.mock("@/lib/messaging/agent-message-template", () => ({
  getOrCreateAgentMessageTemplate: (...args: unknown[]) => getOrCreateAgentMessageTemplateMock(...args),
}))
vi.mock("@/lib/audit", () => ({
  AuditAction: { REMINDER_DISPATCH_RECORDED: "REMINDER_DISPATCH_RECORDED" },
  logAudit: (a: unknown) => logAuditMock(a),
}))

import { POST } from "./route"
import {
  KnownDispatchPersistenceError,
  MessageReconciliationRequiredError,
  SendBlockedError,
} from "@/lib/messaging/send"

const ctx = { params: Promise.resolve({ loanId: "L1" }) }
const OPERATION_ID = "11111111-1111-4111-8111-111111111111"
function makeReq(body: Record<string, unknown>) {
  return new NextRequest("http://x/api/collections/L1/reminder", {
    method: "POST",
    body: JSON.stringify({ operationId: OPERATION_ID, ...body }),
  })
}

const inArrears = {
  id: "L1", status: "DEFAULTED", arrearsAmount: 500_000, outstandingPrincipal: 500_000,
  daysInArrears: 120,
  client: { id: "c1", phone: "+27821111111", whatsapp: "+27822222222", firstName: "A", lastName: "B" },
}
const settled = {
  id: "L1", status: "ACTIVE", arrearsAmount: 0, outstandingPrincipal: 0,
  daysInArrears: 0,
  client: { id: "c1", phone: "+27821111111", whatsapp: null, firstName: "A", lastName: "B" },
}
const contact = { id: "ct1", primaryPhone: "27821111111", primaryWaJid: "27822222222@s.whatsapp.net" }

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "o@x" } })
  withTenantContextMock.mockImplementation((_req: unknown, cb: (t: { id: string }) => Promise<unknown>) =>
    cb({ id: "t1" }))
  loanFindUniqueMock.mockResolvedValue(inArrears)
  contactFindFirstMock.mockResolvedValue(contact)
  getOrCreateAgentMessageTemplateMock.mockResolvedValue({ id: "tpl1" })
  loanNoteCreateMock.mockResolvedValue({ id: "note1" })
  sendMessageMock.mockResolvedValue({ id: "m1", status: "SENT" })
})

describe("POST /api/collections/[loanId]/reminder", () => {
  it("refuses a reminder on a settled account (422), never calls sendMessage", async () => {
    loanFindUniqueMock.mockResolvedValue(settled)

    const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)

    expect(res.status).toBe(422)
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("refuses a reminder on a restructured account with stale positive amounts", async () => {
    loanFindUniqueMock.mockResolvedValue({ ...inArrears, status: "RESTRUCTURED" })

    const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)

    expect(res.status).toBe(422)
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("SMS: routes through sendMessage, no direct bulksms call, writes LoanNote + audit", async () => {
    const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)
    const json = await res.json() as { ok: boolean; channels: string[] }

    expect(res.status).toBe(200)
    expect(json).toMatchObject({
      ok: true,
      channels: ["SMS"],
      simulatedChannels: [],
      pendingChannels: [],
      deliveries: [{ channel: "SMS", outcome: "sent", messageId: "m1" }],
    })
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "ct1",
        channel: "SMS",
        vars: { body: "pay up" },
        toValue: "27821111111",
        category: "manual_reminder",
        loanId: "L1",
        idempotencyKey: `manual-reminder:L1:${OPERATION_ID}:SMS`,
      }),
    )
    expect(loanNoteCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ type: "manual_reminder" }) }),
    )
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "REMINDER_DISPATCH_RECORDED",
        newValue: expect.objectContaining({
          channelsSent: ["SMS"],
          deliveries: [{ channel: "SMS", outcome: "sent", messageId: "m1" }],
        }),
      }),
    )
  })

  it("both channels: sends WA + SMS independently through sendMessage", async () => {
    const res = await POST(makeReq({ channel: "both", message: "pay up" }), ctx)
    const json = await res.json() as { ok: boolean; channels: string[] }

    expect(json.ok).toBe(true)
    expect(json.channels.sort()).toEqual(["SMS", "WhatsApp"].sort())
    expect(sendMessageMock).toHaveBeenCalledTimes(2)
    expect(sendMessageMock).toHaveBeenNthCalledWith(1, expect.objectContaining({
      channel: "SMS",
      idempotencyKey: `manual-reminder:L1:${OPERATION_ID}:SMS`,
    }))
    expect(sendMessageMock).toHaveBeenNthCalledWith(2, expect.objectContaining({
      channel: "WHATSAPP",
      idempotencyKey: `manual-reminder:L1:${OPERATION_ID}:WHATSAPP`,
    }))
  })

  // Prod runs BULKSMS_DRY_RUN=true. The SMS leg used to dispatch anyway and
  // come back SIMULATED — a manual reminder that reads as handled but that
  // the borrower never received.
  describe("SMS channel off (BULKSMS_DRY_RUN=true)", () => {
    afterEach(() => {
      delete process.env.BULKSMS_DRY_RUN
    })

    it("channel=sms: no SMS dispatch, 422, LoanNote names the blocked channel", async () => {
      process.env.BULKSMS_DRY_RUN = "true"

      const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)
      const json = await res.json() as { ok: boolean; deliveries: unknown[] }

      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(res.status).toBe(422)
      expect(json.deliveries).toEqual([
        { channel: "SMS", outcome: "blocked", detail: "SMS not enabled" },
      ])
      const note = loanNoteCreateMock.mock.calls[0][0].data.note as string
      expect(note).toContain("SMS not enabled")
      expect(note).not.toContain("SMS: sent")
    })

    it("channel=both: the WhatsApp leg still sends", async () => {
      process.env.BULKSMS_DRY_RUN = "true"

      const res = await POST(makeReq({ channel: "both", message: "pay up" }), ctx)
      const json = await res.json() as { ok: boolean; channels: string[] }

      expect(json.channels).toEqual(["WhatsApp"])
      expect(sendMessageMock).toHaveBeenCalledOnce()
      expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "WHATSAPP" }))
    })

    it("CHANNEL ON: today's behaviour is unchanged — SMS still dispatched", async () => {
      delete process.env.BULKSMS_DRY_RUN

      const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)

      expect(res.status).toBe(200)
      expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({ channel: "SMS" }))
    })
  })

  it("records a dry-run reminder as simulated and never claims it was sent", async () => {
    sendMessageMock.mockResolvedValue({ id: "m-sim", status: "SIMULATED" })

    const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)
    const json = await res.json() as { ok: boolean; channels: string[]; simulatedChannels: string[] }

    expect(json).toMatchObject({
      ok: true,
      channels: [],
      simulatedChannels: ["SMS"],
      pendingChannels: [],
      deliveries: [{ channel: "SMS", outcome: "simulated", messageId: "m-sim" }],
    })
    expect(loanNoteCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ note: expect.stringContaining("simulated (not sent)") }),
    }))
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "REMINDER_DISPATCH_RECORDED",
      newValue: expect.objectContaining({ channelsSent: [], channelsSimulated: ["SMS"] }),
    }))
  })

  it("eligibility block on the only requested channel: 422, LoanNote records that nothing was sent", async () => {
    sendMessageMock.mockRejectedValue(new SendBlockedError("CHANNEL_OPTED_OUT"))

    const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)
    const json = await res.json() as { ok: boolean; error: string }

    expect(res.status).toBe(422)
    expect(json.ok).toBe(false)
    expect(json.error).toContain("CHANNEL_OPTED_OUT")
    expect(loanNoteCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ note: expect.stringContaining("not sent") }) }),
    )
  })

  it("real dispatch failure (not a block): 502", async () => {
    sendMessageMock.mockRejectedValue(new Error("provider down"))

    const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)

    expect(res.status).toBe(502)
  })

  it("never records edited text as sent when an operation key conflicts", async () => {
    sendMessageMock.mockRejectedValue(
      new Error("The idempotency key is already reserved for a different message request"),
    )

    const res = await POST(makeReq({ channel: "sms", message: "DIFFERENT BODY" }), ctx)

    expect(res.status).toBe(502)
    expect(loanNoteCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        note: expect.stringMatching(/Outcomes: SMS: failed/),
      }),
    }))
    expect(loanNoteCreateMock).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ note: expect.stringMatching(/SMS: sent/) }),
    }))
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      newValue: expect.objectContaining({
        channelsSent: [],
        deliveries: [expect.objectContaining({ channel: "SMS", outcome: "failed" })],
      }),
    }))
  })

  it("requires an operation id before creating a reminder", async () => {
    const res = await POST(makeReq({ channel: "sms", message: "pay up", operationId: undefined }), ctx)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "operationId is required" })
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("rejects an unknown channel before loading or writing any record", async () => {
    const res = await POST(makeReq({ channel: "carrier-pigeon", message: "pay up" }), ctx)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toEqual({ error: "channel must be sms, whatsapp, or both" })
    expect(loanFindUniqueMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(loanNoteCreateMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("returns an explicit do-not-resend reconciliation outcome and records its Message id", async () => {
    sendMessageMock.mockRejectedValue(new MessageReconciliationRequiredError({ id: "m-ambiguous" } as Message))

    const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)
    const json = await res.json() as { reconciliationRequired: boolean; reconciliationMessages: unknown[] }

    expect(res.status).toBe(200)
    expect(json.reconciliationRequired).toBe(true)
    expect(json.reconciliationMessages).toEqual([{ channel: "SMS", messageId: "m-ambiguous" }])
    expect(loanNoteCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ note: expect.stringMatching(/do not resend/i) }),
    }))
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      action: "REMINDER_DISPATCH_RECORDED",
    }))
  })

  it("returns known provider evidence with the reconciliation delivery", async () => {
    sendMessageMock.mockRejectedValue(new KnownDispatchPersistenceError({
      message: { id: "m-known" } as Message,
      outcome: "PROVIDER_ACCEPTED",
      providerMessageId: "provider-known",
      firstWriteError: new Error("terminal write unavailable"),
      recoveryWriteError: new Error("recovery write unavailable"),
      holdWriteError: new Error("hold write unavailable"),
    }))

    const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      reconciliationRequired: true,
      deliveries: [{
        channel: "SMS",
        outcome: "reconciliation_required",
        messageId: "m-known",
        knownDispatchEvidence: {
          outcome: "PROVIDER_ACCEPTED",
          providerMessageId: "provider-known",
        },
      }],
    })
  })

  it("returns a queued idempotent replay as pending, never sent", async () => {
    sendMessageMock.mockResolvedValue({ id: "m-retrying", status: "RETRYING" })

    const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)

    expect(res.status).toBe(202)
    await expect(res.json()).resolves.toMatchObject({
      ok: true,
      pendingChannels: ["SMS"],
      deliveries: [{ channel: "SMS", outcome: "pending", messageId: "m-retrying" }],
    })
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({ action: "REMINDER_DISPATCH_RECORDED" }))
  })

  it("no comms Contact on file: treated as a non-block failure (502), never calls sendMessage", async () => {
    contactFindFirstMock.mockResolvedValue(null)

    const res = await POST(makeReq({ channel: "sms", message: "pay up" }), ctx)
    const json = await res.json() as { error: string }

    expect(res.status).toBe(502)
    expect(json.error).toContain("no comms Contact")
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("partial failure (both requested, one blocked): still 200 with the successful channel + errors surfaced", async () => {
    sendMessageMock
      .mockResolvedValueOnce({ id: "m1", status: "SENT" }) // SMS succeeds
      .mockRejectedValueOnce(new SendBlockedError("REVOKED")) // WhatsApp blocked

    const res = await POST(makeReq({ channel: "both", message: "pay up" }), ctx)
    const json = await res.json() as { ok: boolean; channels: string[]; errors?: string[]; deliveries: unknown[] }

    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(json.channels).toEqual(["SMS"])
    expect(json.errors?.[0]).toContain("REVOKED")
    expect(json.deliveries).toEqual([
      { channel: "SMS", outcome: "sent", messageId: "m1" },
      { channel: "WhatsApp", outcome: "blocked", detail: "REVOKED" },
    ])
  })

  it("preserves SIMULATED + reconciliation as two explicit outcomes", async () => {
    sendMessageMock
      .mockResolvedValueOnce({ id: "m-sim", status: "SIMULATED" })
      .mockRejectedValueOnce(new MessageReconciliationRequiredError({ id: "m-ambiguous" } as Message))

    const res = await POST(makeReq({ channel: "both", message: "pay up" }), ctx)
    const json = await res.json() as { deliveries: unknown[]; reconciliationRequired: boolean }

    expect(json.reconciliationRequired).toBe(true)
    expect(json.deliveries).toEqual([
      { channel: "SMS", outcome: "simulated", messageId: "m-sim" },
      { channel: "WhatsApp", outcome: "reconciliation_required", messageId: "m-ambiguous" },
    ])
  })

  it("preserves SENT + RETRYING as two explicit outcomes", async () => {
    sendMessageMock
      .mockResolvedValueOnce({ id: "m-sent", status: "SENT" })
      .mockResolvedValueOnce({ id: "m-retrying", status: "RETRYING" })

    const res = await POST(makeReq({ channel: "both", message: "pay up" }), ctx)
    const json = await res.json() as { deliveries: unknown[]; pendingChannels: string[] }

    expect(res.status).toBe(200)
    expect(json.pendingChannels).toEqual(["WhatsApp"])
    expect(json.deliveries).toEqual([
      { channel: "SMS", outcome: "sent", messageId: "m-sent" },
      { channel: "WhatsApp", outcome: "pending", messageId: "m-retrying" },
    ])
  })
})
