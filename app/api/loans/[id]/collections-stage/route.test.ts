import { describe, it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"
import type { Message } from "@prisma/client"

const requireApiRoleMock = vi.fn()
const withTenantContextMock = vi.fn()
const loanFindUniqueMock = vi.fn()
const loanUpdateMock = vi.fn()
const transactionMock = vi.fn()
const queryRawMock = vi.fn()
const contactFindFirstMock = vi.fn()
const sendMessageMock = vi.fn()
const getOrCreateAgentMessageTemplateMock = vi.fn()
const logAuditMock = vi.fn()
const auditCreateMock = vi.fn()
const chargesOutstandingAtMock = vi.fn()
const waOverdue7dMock = vi.fn((..._a: unknown[]) => "7d msg")

const findLenderIdentityMock = vi.hoisted(() => vi.fn())
vi.mock("@/lib/config/identity", async (orig) => {
  const actual = await orig<typeof import("@/lib/config/identity")>()
  const { VALID_LENDER_COLUMNS } = await import("@/lib/config/__fixtures__/lender-identity")
  findLenderIdentityMock.mockResolvedValue(actual.parseLenderIdentity(VALID_LENDER_COLUMNS))
  return { ...actual, findLenderIdentity: (...args: unknown[]) => findLenderIdentityMock(...args) }
})
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: () => requireApiRoleMock(),
  // act_on_collections itself is proved with the real guards in app/api/collections-scope-rbac.test.ts.
  canDo: () => true,
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
    withTenantContextMock(req, cb),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    $transaction: (...a: unknown[]) => transactionMock(...a),
    loan: {
      findUnique: (a: unknown) => loanFindUniqueMock(a),
      update: (a: unknown) => loanUpdateMock(a),
    },
    contact: { findFirst: (a: unknown) => contactFindFirstMock(a) },
  },
}))
vi.mock("@/lib/whatsapp", () => ({
  WA_TEMPLATES: {
    section129: () => "s129 msg",
    payment_overdue_7d: (...a: unknown[]) => waOverdue7dMock(...a),
    payment_overdue_1d: () => "1d msg",
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
vi.mock("@/lib/audit", () => ({ logAudit: (a: unknown) => logAuditMock(a) }))
vi.mock("@/lib/utils", () => ({ formatZAR: (n: number) => `R${n}` }))
vi.mock("@/lib/loan/charges-replay", () => ({
  chargesOutstandingAt: (...a: unknown[]) => chargesOutstandingAtMock(...a),
}))

import { PATCH } from "./route"
import {
  KnownDispatchPersistenceError,
  MessageReconciliationRequiredError,
  SendBlockedError,
} from "@/lib/messaging/send"

const ctx = { params: Promise.resolve({ id: "L1" }) }
function makeReq(body: unknown) {
  return new NextRequest("http://x/api/loans/L1/collections-stage", {
    method: "PATCH",
    body: JSON.stringify(body),
  })
}
const settled = { id: "L1", status: "ACTIVE", collectionsStage: "NONE", arrearsAmount: 0, outstandingPrincipal: 0, daysInArrears: 120, reference: "LN", client: { id: "c1", firstName: "A", lastName: "B", phone: "+27", whatsapp: null } }
const inArrears = { id: "L1", status: "DEFAULTED", collectionsStage: "NONE", arrearsAmount: 500_000, outstandingPrincipal: 500_000, daysInArrears: 120, reference: "LN", client: { id: "c1", firstName: "A", lastName: "B", phone: "+27", whatsapp: null } }
// Stale arrears with the principal already fully repaid — the N-03 case: a
// loan whose arrearsAmount check alone would pass, but which owes nothing.
const repaidWithStaleArrears = { id: "L1", status: "ACTIVE", collectionsStage: "NONE", arrearsAmount: 156_000, outstandingPrincipal: 0, daysInArrears: 45, reference: "LN", client: { id: "c1", firstName: "A", lastName: "B", phone: "+27", whatsapp: null } }
// Current, not settled: arrears cleared but principal still owed. An earlier
// error wording ("no collectible balance ... settled or has nothing
// outstanding") misdescribed exactly this leg — the loan is neither settled
// nor "nothing outstanding," it's just not currently in arrears.
const currentNotSettled = { id: "L1", status: "ACTIVE", collectionsStage: "NONE", arrearsAmount: 0, outstandingPrincipal: 500_000, daysInArrears: 0, reference: "LN", client: { id: "c1", firstName: "A", lastName: "B", phone: "+27", whatsapp: null } }

const contact = { id: "ct1", primaryWaJid: "27@s.whatsapp.net", primaryPhone: "27" }

describe("PATCH collections-stage — settled-account guard", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "o@x" } })
    withTenantContextMock.mockImplementation((_req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
      cb({ id: "t1", name: "Acme Lending" }))
    loanUpdateMock.mockResolvedValue({ id: "L1" })
    queryRawMock.mockResolvedValue([])
    transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({
      $queryRaw: queryRawMock,
      loan: {
        findUnique: (args: unknown) => loanFindUniqueMock(args),
        update: (args: unknown) => loanUpdateMock(args),
      },
      auditLog: { create: (args: unknown) => auditCreateMock(args) },
    }))
    contactFindFirstMock.mockResolvedValue(contact)
    getOrCreateAgentMessageTemplateMock.mockResolvedValue({ id: "tpl1" })
    sendMessageMock.mockResolvedValue({ id: "m1", status: "SENT" })
    auditCreateMock.mockResolvedValue({ id: "audit-1" })
    chargesOutstandingAtMock.mockResolvedValue(0)
  })

  // Default charges: the
  // reminder quotes arrears + default charges outstanding; 0 while the flag is off.
  it("the dunning WhatsApp quotes arrears + default charges outstanding", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    chargesOutstandingAtMock.mockResolvedValue(37_000)
    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)
    expect(res.status).toBe(200)
    expect(chargesOutstandingAtMock).toHaveBeenCalledWith(
      expect.anything(),
      { tenantId: "t1", loanId: "L1" },
      expect.any(Date),
    )
    expect(waOverdue7dMock.mock.calls[0][1]).toBe("R537000")
  })

  it("does not send the 7-day dunning WhatsApp without a configured lender identity, and audits why", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    findLenderIdentityMock.mockResolvedValueOnce(null)
    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)
    expect(res.status).toBe(200)
    expect(waOverdue7dMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(JSON.stringify(logAuditMock.mock.calls)).toContain("lender_identity_not_configured")
  })

  it("quotes the lender's configured collections number in the 7-day dunning WhatsApp", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)
    expect(waOverdue7dMock.mock.calls[0][3]).toBe("+27 11 000 0001")
  })

  it("flag off (charges 0): the dunning WhatsApp amount is unchanged", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)
    expect(waOverdue7dMock.mock.calls[0][1]).toBe("R500000")
  })

  it("refuses a dunning reminder stage on a settled R0 loan (422), sends no WhatsApp, makes no update", async () => {
    loanFindUniqueMock.mockResolvedValue(settled)
    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)
    const json = await res.json() as { error: string }
    expect(res.status).toBe(422)
    expect(json.error).toBe("Cannot apply a collections stage: the account has no positive arrears to collect.")
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses a dunning reminder stage on a current (R0-arrears, principal still owed) loan (422), sends no WhatsApp, makes no update", async () => {
    loanFindUniqueMock.mockResolvedValue(currentNotSettled)
    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)
    const json = await res.json() as { error: string }
    expect(res.status).toBe(422)
    expect(json.error).toBe("Cannot apply a collections stage: the account has no positive arrears to collect.")
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses a dunning reminder stage on a settled R0 loan (422)", async () => {
    loanFindUniqueMock.mockResolvedValue(settled)
    const res = await PATCH(makeReq({ stage: "SOFT_REMINDER" }), ctx)
    expect(res.status).toBe(422)
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("allows a dunning reminder stage on a loan genuinely in arrears (200 + WA sent via sendMessage, no direct provider call)", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)
    expect(res.status).toBe(200)
    expect(sendMessageMock).toHaveBeenCalledTimes(1)
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: "ct1",
        channel: "WHATSAPP",
        toValue: "27@s.whatsapp.net",
        category: "collections_stage_reminder",
        loanId: "L1",
        idempotencyKey: "collections-stage:L1:FORMAL_REMINDER:WHATSAPP",
      }),
    )
    expect(auditCreateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({
        action: "COLLECTIONS_STAGE_UPDATED",
        oldValue: { stage: "NONE" },
        newValue: { stage: "FORMAL_REMINDER" },
      }) }),
    )
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "COLLECTIONS_STAGE_REMINDER_OUTCOME",
        newValue: expect.objectContaining({ outcome: "sent" }),
      }),
    )
    expect(queryRawMock).toHaveBeenCalled()
  })

  it("rolls back the stage mutation when its atomic audit cannot be written", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    auditCreateMock.mockRejectedValue(new Error("audit unavailable"))

    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)

    expect(res.status).toBe(500)
    expect(loanUpdateMock).toHaveBeenCalledOnce()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it.each(["FORMAL_REMINDER", "SECTION_129_SENT", "PAYMENT_ARRANGEMENT", "ATTORNEY_REFERRED", "WRITTEN_OFF"])(
    "refuses to regress %s to SOFT_REMINDER under the loan lock",
    async (collectionsStage) => {
      loanFindUniqueMock.mockResolvedValue({ ...inArrears, collectionsStage })

      const res = await PATCH(makeReq({ stage: "SOFT_REMINDER" }), ctx)

      expect(res.status).toBe(409)
      expect(queryRawMock).toHaveBeenCalled()
      expect(loanUpdateMock).not.toHaveBeenCalled()
      expect(sendMessageMock).not.toHaveBeenCalled()
      expect(auditCreateMock).not.toHaveBeenCalled()
      expect(logAuditMock).not.toHaveBeenCalled()
    },
  )

  it("allows a monotonic SOFT_REMINDER to FORMAL_REMINDER transition", async () => {
    loanFindUniqueMock.mockResolvedValue({ ...inArrears, collectionsStage: "SOFT_REMINDER" })

    expect((await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)).status).toBe(200)
    expect(loanUpdateMock).toHaveBeenCalledOnce()
  })

  // N-03 / SEED-0010: arrears>0 but outstandingPrincipal=0 (settled). The old
  // "not in arrears" copy read wrong for exactly this case — the message
  // must cover every leg of the gate (arrears-cleared, settled, AND current).
  it("refuses a dunning reminder stage on a fully-repaid loan carrying stale arrears (422), sends no WhatsApp, makes no update", async () => {
    loanFindUniqueMock.mockResolvedValue(repaidWithStaleArrears)
    const res = await PATCH(makeReq({ stage: "SOFT_REMINDER" }), ctx)
    const json = await res.json() as { error: string }
    expect(res.status).toBe(422)
    expect(json.error).toBe("Cannot apply a collections stage: the account has no outstanding principal.")
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("refuses dunning on a cancelled account even when stale amounts remain positive", async () => {
    loanFindUniqueMock.mockResolvedValue({ ...inArrears, status: "CANCELLED" })

    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)

    expect(res.status).toBe(422)
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(loanUpdateMock).not.toHaveBeenCalled()
  })

  it("eligibility block: stage update + audit still succeed, but the audit records the block truthfully (no fake success)", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    sendMessageMock.mockRejectedValue(new SendBlockedError("CHANNEL_OPTED_OUT"))

    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)

    expect(res.status).toBe(200)
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: expect.objectContaining({ outcome: "blocked:CHANNEL_OPTED_OUT" }) }),
    )
  })

  it("dispatch failure: logged loudly, audit records 'failed' rather than pretending success", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    sendMessageMock.mockRejectedValue(new Error("provider down"))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)

    expect(res.status).toBe(200)
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: expect.objectContaining({ outcome: "failed" }) }),
    )
    expect(errorSpy).toHaveBeenCalled()
  })

  it("ambiguous dispatch is audited as reconciliation-required and cannot be replayed", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    sendMessageMock.mockRejectedValue(new MessageReconciliationRequiredError({ id: "m-ambiguous" } as Message))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)

    expect(res.status).toBe(200)
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      newValue: expect.objectContaining({ outcome: "reconciliation_required:m-ambiguous" }),
    }))
    expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/automatic replay blocked/))
    errorSpy.mockRestore()
  })

  it("audits known provider evidence for staff reconciliation", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    sendMessageMock.mockRejectedValue(new KnownDispatchPersistenceError({
      message: { id: "m-known" } as Message,
      outcome: "PROVIDER_ACCEPTED",
      providerMessageId: "provider-known",
      firstWriteError: new Error("terminal write unavailable"),
      recoveryWriteError: new Error("recovery write unavailable"),
      holdWriteError: new Error("hold write unavailable"),
    }))
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)

    expect(res.status).toBe(200)
    expect(logAuditMock).toHaveBeenCalledWith(expect.objectContaining({
      newValue: expect.objectContaining({
        outcome: "reconciliation_required:m-known",
        knownDispatchEvidence: {
          outcome: "PROVIDER_ACCEPTED",
          providerMessageId: "provider-known",
        },
      }),
    }))
    errorSpy.mockRestore()
  })

  it("dry-run dispatch is audited as simulated, never sent", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    sendMessageMock.mockResolvedValue({ id: "m-sim", status: "SIMULATED" })

    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)

    expect(res.status).toBe(200)
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: expect.objectContaining({ outcome: "simulated" }) }),
    )
    expect(logAuditMock).not.toHaveBeenCalledWith(
      expect.objectContaining({ newValue: expect.objectContaining({ outcome: "sent" }) }),
    )
  })

  it("no comms Contact on file: skips the send, logs loudly, audit records 'no_contact'", async () => {
    loanFindUniqueMock.mockResolvedValue(inArrears)
    contactFindFirstMock.mockResolvedValue(null)
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    const res = await PATCH(makeReq({ stage: "FORMAL_REMINDER" }), ctx)

    expect(res.status).toBe(200)
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(logAuditMock).toHaveBeenCalledWith(
      expect.objectContaining({ newValue: expect.objectContaining({ outcome: "no_contact" }) }),
    )
    expect(errorSpy).toHaveBeenCalled()
  })
})

describe("PATCH collections-stage — single Section 129 action path", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "o@x" } })
    withTenantContextMock.mockImplementation((_req: unknown, cb: (t: { id: string; name: string }) => Promise<unknown>) =>
      cb({ id: "t1", name: "Acme Lending" }))
    loanUpdateMock.mockResolvedValue({ id: "L1" })
    queryRawMock.mockResolvedValue([])
    transactionMock.mockImplementation((cb: (tx: unknown) => Promise<unknown>) => cb({
      $queryRaw: queryRawMock,
      loan: {
        findUnique: (args: unknown) => loanFindUniqueMock(args),
        update: (args: unknown) => loanUpdateMock(args),
      },
      auditLog: { create: (args: unknown) => auditCreateMock(args) },
    }))
    contactFindFirstMock.mockResolvedValue(contact)
    getOrCreateAgentMessageTemplateMock.mockResolvedValue({ id: "tpl1" })
    sendMessageMock.mockResolvedValue({ id: "m1" })
    auditCreateMock.mockResolvedValue({ id: "audit-1" })
  })

  it("rejects a direct transition into SECTION_129_SENT (400), even on a loan in arrears", async () => {
    const res = await PATCH(makeReq({ stage: "SECTION_129_SENT" }), ctx)
    const json = await res.json() as { error: string }

    expect(res.status).toBe(400)
    expect(json.error).toMatch(/S\.129 Notice/)
    expect(loanFindUniqueMock).not.toHaveBeenCalled()
    expect(loanUpdateMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
    expect(logAuditMock).not.toHaveBeenCalled()
  })

  it("rejects a direct transition into SECTION_129_SENT (400) regardless of arrears state", async () => {
    loanFindUniqueMock.mockResolvedValue(settled)
    const res = await PATCH(makeReq({ stage: "SECTION_129_SENT" }), ctx)
    expect(res.status).toBe(400)
  })

  it.each(["PAYMENT_ARRANGEMENT", "ATTORNEY_REFERRED", "WRITTEN_OFF"])(
    "rejects direct %s transitions in favour of the dedicated audited action",
    async (stage) => {
      const res = await PATCH(makeReq({ stage }), ctx)

      expect(res.status).toBe(400)
      expect(loanFindUniqueMock).not.toHaveBeenCalled()
      expect(loanUpdateMock).not.toHaveBeenCalled()
      expect(logAuditMock).not.toHaveBeenCalled()
    },
  )
})
