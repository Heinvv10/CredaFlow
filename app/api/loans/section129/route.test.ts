import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { parseLenderIdentity } from "@/lib/config/identity"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

const requireApiRoleMock = vi.fn()
const lenderIdentityMock = vi.fn()
const loanFindUniqueMock = vi.fn()
const sendEmailMock = vi.fn()
const sendMessageMock = vi.fn()
const lookupContactMock = vi.fn()
const messageTemplateFindFirstMock = vi.fn()
const logAuditMock = vi.fn()
const triggerNotificationMock = vi.fn()
const buildAttachmentsMock = vi.fn()
const reserveIssuanceMock = vi.fn()
const dispatchUnderLockMock = vi.fn()
const markKnownNotSentMock = vi.fn()
const markReconciliationRequiredMock = vi.fn()
const finaliseIssuanceMock = vi.fn()

// No tenant logo unless a test sets one: documents print the text letterhead.
const getLenderLogoMock = vi.fn()
vi.mock("@/lib/config/lender-logo", () => ({ getLenderLogo: (tenantId: string) => getLenderLogoMock(tenantId) }))
vi.mock("@/lib/config/identity-response", () => ({
  lenderIdentityOrRefusal: (tenantId: string) => lenderIdentityMock(tenantId),
}))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: () => requireApiRoleMock() }))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string; name: string }) => Promise<unknown>) =>
    cb({ id: "t1", name: "Acme Lending" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findUnique: (args: unknown) => loanFindUniqueMock(args) },
    messageTemplate: { findFirst: (args: unknown) => messageTemplateFindFirstMock(args) },
  },
}))
vi.mock("@/lib/email/service", () => ({
  sendEmail: (args: { onProviderDispatchStart?: () => void }) => {
    args.onProviderDispatchStart?.()
    return sendEmailMock(args)
  },
}))
vi.mock("@/lib/messaging/send", () => ({
  sendMessage: (args: { onProviderDispatchStart?: () => void }) => {
    args.onProviderDispatchStart?.()
    return sendMessageMock(args)
  },
}))
vi.mock("@/lib/contact/identity", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  lookupContactByChannelValue: (...args: unknown[]) => lookupContactMock(...args),
}))
vi.mock("@/lib/email/templates/section129", () => ({
  section129Html: () => "<p>html</p>",
  section129Text: () => "text",
}))
const { settlementFiguresMock } = vi.hoisted(() => ({ settlementFiguresMock: vi.fn() }))
vi.mock("@/lib/loan/charges-summary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/charges-summary")>()),
  loanSettlementFigures: (...args: unknown[]) => settlementFiguresMock(...args),
}))
vi.mock("@/lib/email/section129-attachments", () => ({
  buildSection129Attachments: (args: unknown) => buildAttachmentsMock(args),
}))
vi.mock("@/lib/notifications", () => ({
  triggerNotification: (args: unknown) => triggerNotificationMock(args),
}))
vi.mock("@/lib/audit", () => ({ logAudit: (args: unknown) => logAuditMock(args) }))
vi.mock("@/lib/collections/section129-artifact", () => ({
  Section129IssuanceConflictError: class Section129IssuanceConflictError extends Error {
    issuanceId: string | null
    lifecycle: string | null
    constructor(message: string, issuanceId: string | null = null, lifecycle: string | null = null) {
      super(message)
      this.issuanceId = issuanceId
      this.lifecycle = lifecycle
    }
  },
  Section129DispatchUncertainError: class Section129DispatchUncertainError extends Error {},
  reserveSection129Issuance: (args: unknown) => reserveIssuanceMock(args),
  dispatchSection129UnderEligibilityLock: (args: unknown) => dispatchUnderLockMock(args),
  markSection129KnownNotSent: (...args: unknown[]) => markKnownNotSentMock(...args),
  markSection129ReconciliationRequired: (...args: unknown[]) => markReconciliationRequiredMock(...args),
  finaliseSection129Issuance: (args: unknown) => finaliseIssuanceMock(args),
  section129NoticeDateLabel: () => "19 July 2026",
}))

import {
  Section129DispatchUncertainError,
  Section129IssuanceConflictError,
} from "@/lib/collections/section129-artifact"
import { ProviderDispatchError } from "@/lib/messaging/providers"
import { POST } from "./route"

function request() {
  return new NextRequest("http://x/api/loans/section129", {
    method: "POST",
    body: JSON.stringify({ loanId: "L1" }),
  })
}

const loan = {
  id: "L1",
  clientId: "C1",
  status: "DEFAULTED",
  arrearsAmount: 500_000,
  outstandingPrincipal: 1_000_000,
  daysInArrears: 90,
  reference: "LN-1",
  client: {
    firstName: "A",
    lastName: "B",
    idNumber: "1",
    email: "a@x.com",
    addressLine1: null,
    city: null,
  },
}
const reservation = {
  issuanceId: "issue-1",
  idempotencyKey: "t1:SECTION_129_NOTICE:L1",
  pdfSha256: "a".repeat(64),
  recordData: { lifecycle: "READY", noticeDate: "19 July 2026" },
}
const template = {
  id: "tpl_s129",
  key: "section129_email",
  channel: "EMAIL",
  statutoryOverride: true,
}
const providerAcceptedAt = new Date("2026-07-19T10:00:00.000Z")

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.MESSAGING_NEW_SEND_S129
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "o@x" } })
  loanFindUniqueMock.mockResolvedValue(loan)
  // No default charges unless a test says so: the notice states the loan's own figures.
  settlementFiguresMock.mockImplementation(async (_db: unknown, l: { arrearsAmount: number; outstandingPrincipal: number }) => ({
    live: false, charges: null, chargeLines: [], chargesOutstanding: 0, interestAndFeesOutstanding: 0,
    totalToSettle: l.outstandingPrincipal, arrearsIncludingCharges: l.arrearsAmount,
  }))
  buildAttachmentsMock.mockResolvedValue([{ contentType: "application/pdf", content: Buffer.from("%PDF") }])
  reserveIssuanceMock.mockResolvedValue(reservation)
  dispatchUnderLockMock.mockImplementation(async (args: { dispatch: (mark: () => void) => Promise<unknown> }) => {
    let providerInvoked = false
    const mark = () => { providerInvoked = true }
    try {
      const value = await args.dispatch(mark)
      return { kind: "PROVIDER_RETURNED", value, providerInvoked }
    } catch (error) {
      return { kind: "PROVIDER_THREW", error, providerInvoked }
    }
  })
  markKnownNotSentMock.mockResolvedValue(undefined)
  markReconciliationRequiredMock.mockResolvedValue(undefined)
  finaliseIssuanceMock.mockResolvedValue(undefined)
  sendEmailMock.mockResolvedValue({ ok: true, messageId: "mail-1", providerOutcome: "ACCEPTED", acceptedAt: providerAcceptedAt })
  sendMessageMock.mockResolvedValue({ id: "msg-1", providerMessageId: "provider-1", sentAt: providerAcceptedAt })
  messageTemplateFindFirstMock.mockResolvedValue(template)
  lookupContactMock.mockResolvedValue({ id: "contact-1" })
  triggerNotificationMock.mockResolvedValue(undefined)
  lenderIdentityMock.mockResolvedValue({ identity: parseLenderIdentity(VALID_LENDER_COLUMNS) })
})

afterEach(() => {
  delete process.env.MESSAGING_NEW_SEND_S129
})

describe("POST /api/loans/section129", () => {
  // no configured, valid lender identity ⇒ no notice can be issued.
  it("refuses with 409 before reserving or sending when the lender identity is not configured", async () => {
    lenderIdentityMock.mockResolvedValue({
      refusal: NextResponse.json({ code: "LENDER_IDENTITY_NOT_CONFIGURED" }, { status: 409 }),
    })
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect(reserveIssuanceMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(buildAttachmentsMock).not.toHaveBeenCalled()
  })

  it("prints the tenant's configured NCR number on the notice", async () => {
    await POST(request())
    expect(buildAttachmentsMock).toHaveBeenCalledWith(expect.objectContaining({
      lender: expect.objectContaining({ ncrNumber: "NCRCP99999" }),
    }))
  })

  it("prints the tenant's own uploaded logo on the notice, and the text letterhead without one", async () => {
    const logo = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
    getLenderLogoMock.mockResolvedValueOnce(logo)
    await POST(request())
    expect(getLenderLogoMock).toHaveBeenCalledWith("t1")
    expect(buildAttachmentsMock.mock.calls[0][0].logo).toBe(logo)
    await POST(request())
    expect(buildAttachmentsMock.mock.calls[1][0].logo).toBeUndefined()
  })

  it("reserves before provider dispatch and atomically finalises a successful legacy send", async () => {
    const response = await POST(request())
    const body = await response.json() as {
      ok: boolean
      issuanceId: string
      providerAccepted: boolean
      providerOutcome: string
      dispatchState: string
    }

    expect(response.status).toBe(200)
    expect(body).toMatchObject({
      ok: true,
      issuanceId: "issue-1",
      providerAccepted: true,
      providerOutcome: "ACCEPTED",
      dispatchState: "ISSUED",
    })
    expect(reserveIssuanceMock.mock.invocationCallOrder[0]).toBeLessThan(dispatchUnderLockMock.mock.invocationCallOrder[0])
    expect(dispatchUnderLockMock.mock.invocationCallOrder[0]).toBeLessThan(sendEmailMock.mock.invocationCallOrder[0])
    expect(finaliseIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({
      reservation,
      loanId: "L1",
      emailMessageId: "mail-1",
      issuedAt: providerAcceptedAt,
    }))
    expect(logAuditMock).not.toHaveBeenCalled()
    expect(triggerNotificationMock).toHaveBeenCalledOnce()
  })

  it("states the charge-inclusive arrears and the amount that settles the loan on the notice, its snapshot and its email", async () => {
    settlementFiguresMock.mockResolvedValue({
      live: true, charges: {}, chargeLines: [{ label: "Default interest", amount: 30_000 }], chargesOutstanding: 30_000,
      interestAndFeesOutstanding: 50_000, totalToSettle: 1_080_000, arrearsIncludingCharges: 530_000,
    })
    await POST(request())
    expect(buildAttachmentsMock).toHaveBeenCalledWith(expect.objectContaining({
      loan: expect.objectContaining({
        arrearsAmount: 530_000, outstandingPrincipal: 1_000_000, totalOutstanding: 1_080_000, chargesOutstanding: 30_000,
      }),
    }))
    expect(reserveIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({
      arrearsAmount: 530_000, outstandingPrincipal: 1_000_000, totalOutstanding: 1_080_000, chargesOutstanding: 30_000,
    }))
  })

  it("states exactly the loan's own figures, and nothing more, while default charges are off", async () => {
    await POST(request())
    const attachmentLoan = buildAttachmentsMock.mock.calls[0][0].loan
    expect(attachmentLoan).toEqual({
      reference: loan.reference, arrearsAmount: loan.arrearsAmount,
      outstandingPrincipal: loan.outstandingPrincipal, daysInArrears: loan.daysInArrears,
    })
    const reserved = reserveIssuanceMock.mock.calls[0][0]
    expect(reserved).not.toHaveProperty("totalOutstanding")
    expect(reserved).not.toHaveProperty("chargesOutstanding")
  })

  it("locks an ambiguous provider failure for reconciliation instead of permitting a retry", async () => {
    sendEmailMock.mockResolvedValue({ ok: false, error: "smtp-down", providerOutcome: "AMBIGUOUS" })

    const response = await POST(request())
    const body = await response.json() as { reconciliationRequired: boolean; providerOutcome: string; dispatchState: string }

    expect(response.status).toBe(502)
    expect(body.reconciliationRequired).toBe(true)
    expect(body.providerOutcome).toBe("AMBIGUOUS")
    expect(body.dispatchState).toBe("DELIVERY_UNCERTAIN")
    expect(markReconciliationRequiredMock).toHaveBeenCalledWith(expect.objectContaining({
      reservation,
      reason: "smtp-down",
    }))
    expect(markKnownNotSentMock).not.toHaveBeenCalled()
    expect(finaliseIssuanceMock).not.toHaveBeenCalled()
  })

  it("deletes and releases a legacy notice after an explicit provider rejection", async () => {
    sendEmailMock.mockResolvedValue({
      ok: false,
      error: "recipient rejected",
      providerOutcome: "DEFINITELY_REJECTED",
    })

    const response = await POST(request())
    const body = await response.json() as { reconciliationRequired: boolean; providerOutcome: string; dispatchState: string }

    expect(response.status).toBe(422)
    expect(body.reconciliationRequired).toBe(false)
    expect(body.providerOutcome).toBe("DEFINITELY_REJECTED")
    expect(body.dispatchState).toBe("KNOWN_NOT_SENT")
    expect(markKnownNotSentMock).toHaveBeenCalledWith(expect.objectContaining({
      reason: "recipient rejected",
    }))
    expect(markReconciliationRequiredMock).not.toHaveBeenCalled()
  })

  it("deletes and releases a new-pipeline notice after an explicit provider rejection", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    sendMessageMock.mockRejectedValue(
      new ProviderDispatchError("recipient rejected", "DEFINITELY_REJECTED"),
    )

    const response = await POST(request())
    const body = await response.json() as { reconciliationRequired: boolean }

    expect(response.status).toBe(422)
    expect(body.reconciliationRequired).toBe(false)
    expect(markKnownNotSentMock).toHaveBeenCalledWith(expect.objectContaining({
      reason: "recipient rejected",
    }))
    expect(markReconciliationRequiredMock).not.toHaveBeenCalled()
  })

  it("returns 202 and keeps the reservation locked when the provider accepts but DB finalisation fails", async () => {
    finaliseIssuanceMock.mockRejectedValue(new Error("db-down"))

    const response = await POST(request())
    const body = await response.json() as { providerAccepted: boolean; providerOutcome: string; dispatchState: string; reconciliationRequired: boolean; delivered?: boolean }

    expect(response.status).toBe(202)
    expect(body).toMatchObject({
      providerAccepted: true,
      providerOutcome: "ACCEPTED",
      dispatchState: "LEGAL_RECORD_RECONCILIATION_REQUIRED",
      reconciliationRequired: true,
    })
    expect(body).not.toHaveProperty("delivered")
    expect(markReconciliationRequiredMock).toHaveBeenCalled()
    expect(triggerNotificationMock).not.toHaveBeenCalled()
  })

  it("reports an uncommitted provider invocation as ambiguous without claiming delivery", async () => {
    dispatchUnderLockMock.mockRejectedValue(new Section129DispatchUncertainError("transaction timed out"))

    const response = await POST(request())
    const body = await response.json() as {
      providerOutcome: string
      dispatchState: string
      reconciliationRequired: boolean
      delivered?: boolean
    }

    expect(response.status).toBe(202)
    expect(body).toMatchObject({
      providerOutcome: "AMBIGUOUS",
      dispatchState: "DELIVERY_UNCERTAIN",
      reconciliationRequired: true,
    })
    expect(body).not.toHaveProperty("delivered")
  })

  it("remains non-retryable when the reconciliation promotion fails during the same DB incident", async () => {
    finaliseIssuanceMock.mockRejectedValue(new Error("db-down"))
    markReconciliationRequiredMock.mockRejectedValue(new Error("db-still-down"))

    const response = await POST(request())
    const body = await response.json() as { reconciliationRequired: boolean; providerAccepted: boolean; dispatchState: string; delivered?: boolean }

    expect(response.status).toBe(202)
    expect(body.reconciliationRequired).toBe(true)
    expect(body.providerAccepted).toBe(true)
    expect(body.dispatchState).toBe("LEGAL_RECORD_RECONCILIATION_REQUIRED")
    expect(body).not.toHaveProperty("delivered")
  })

  it.each([
    { status: "COMPLETED", arrearsAmount: 500_000, outstandingPrincipal: 1_000_000, daysInArrears: 90 },
    { status: "DEFAULTED", arrearsAmount: 0, outstandingPrincipal: 1_000_000, daysInArrears: 90 },
    { status: "DEFAULTED", arrearsAmount: 500_000, outstandingPrincipal: 0, daysInArrears: 90 },
    { status: "DEFAULTED", arrearsAmount: 500_000, outstandingPrincipal: 1_000_000, daysInArrears: 89 },
  ])("rejects ineligible issuance before reservation ($status, $daysInArrears DPD)", async (overrides) => {
    loanFindUniqueMock.mockResolvedValue({ ...loan, ...overrides })

    const response = await POST(request())

    expect(response.status).toBe(422)
    expect(reserveIssuanceMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("returns 409 without cleanup duplication when the locked operative snapshot changed", async () => {
    dispatchUnderLockMock.mockResolvedValue({
      kind: "SNAPSHOT_CHANGED",
      error: new Error("operative notice snapshot changed"),
    })

    const response = await POST(request())

    expect(response.status).toBe(409)
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(markKnownNotSentMock).not.toHaveBeenCalled()
    expect(markReconciliationRequiredMock).not.toHaveBeenCalled()
  })

  it("maps an active reservation or cooldown collision to 409 without invoking the provider", async () => {
    reserveIssuanceMock.mockRejectedValue(
      new Section129IssuanceConflictError("already issued", "issue-old", "ISSUED"),
    )

    const response = await POST(request())
    const body = await response.json() as { issuanceId: string }

    expect(response.status).toBe(409)
    expect(body.issuanceId).toBe("issue-old")
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("uses the new message pipeline when enabled", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(sendMessageMock).toHaveBeenCalledWith(expect.objectContaining({
      contactId: "contact-1",
      category: "section129",
      loanId: "L1",
    }))
    expect(finaliseIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({
      emailMessageId: "provider-1",
      issuedAt: providerAcceptedAt,
    }))
  })

  it("stores Graph request evidence when the legacy EmailLog write fails", async () => {
    const providerEvidenceReference =
      "MSGRAPH_CLIENT_REQUEST_ID:00000000-0000-4000-8000-000000000010"
    sendEmailMock.mockResolvedValue({
      ok: true,
      providerOutcome: "ACCEPTED",
      acceptedAt: providerAcceptedAt,
      providerEvidenceReference,
      emailLogPersistenceError: "database unavailable",
    })

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(finaliseIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({
      emailMessageId: undefined,
      providerEvidenceReference,
      providerPersistenceWarning:
        "EmailLog persistence failed after provider acceptance: database unavailable",
      issuedAt: providerAcceptedAt,
    }))
  })

  it("finalises known acceptance instead of downgrading a Message persistence failure", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    const providerEvidenceReference =
      "MSGRAPH_CLIENT_REQUEST_ID:00000000-0000-4000-8000-000000000011"
    sendMessageMock.mockRejectedValue(Object.assign(new Error("terminal writes failed"), {
      name: "KnownDispatchPersistenceError",
      outcome: "PROVIDER_ACCEPTED",
      providerAcceptedAt,
      evidenceReference: providerEvidenceReference,
      evidenceAuditWriteError: new Error("emergency audit failed"),
    }))

    const response = await POST(request())

    expect(response.status).toBe(200)
    expect(markReconciliationRequiredMock).not.toHaveBeenCalled()
    expect(finaliseIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({
      providerEvidenceReference,
      providerPersistenceWarning:
        "Provider accepted the notice, but the terminal Message state could not be persisted.",
      emergencyEvidenceAuditPersisted: false,
      issuedAt: providerAcceptedAt,
    }))
  })

  it("keeps accepted provider evidence when legal finalisation needs reconciliation", async () => {
    const providerEvidenceReference =
      "MSGRAPH_CLIENT_REQUEST_ID:00000000-0000-4000-8000-000000000012"
    sendEmailMock.mockResolvedValue({
      ok: true,
      providerOutcome: "ACCEPTED",
      acceptedAt: providerAcceptedAt,
      providerEvidenceReference,
      emailLogPersistenceError: "database unavailable",
    })
    finaliseIssuanceMock.mockRejectedValue(new Error("legal record unavailable"))

    const response = await POST(request())

    expect(response.status).toBe(202)
    expect(markReconciliationRequiredMock).toHaveBeenCalledWith(expect.objectContaining({
      providerEvidenceReference,
      providerAcceptedAt,
      providerPersistenceWarning:
        "EmailLog persistence failed after provider acceptance: database unavailable",
    }))
  })

  it("requires reconciliation instead of inventing an issuance time after provider acceptance", async () => {
    sendEmailMock.mockResolvedValue({ ok: true, messageId: "mail-1", providerOutcome: "ACCEPTED" })

    const response = await POST(request())
    const body = await response.json() as {
      reconciliationRequired: boolean
      providerAccepted: boolean
      providerOutcome: string
      dispatchState: string
      delivered?: boolean
    }

    expect(response.status).toBe(202)
    expect(body.reconciliationRequired).toBe(true)
    expect(body.providerAccepted).toBe(true)
    expect(body.providerOutcome).toBe("ACCEPTED")
    expect(body.dispatchState).toBe("LEGAL_RECORD_RECONCILIATION_REQUIRED")
    expect(body).not.toHaveProperty("delivered")
    expect(finaliseIssuanceMock).not.toHaveBeenCalled()
    expect(markReconciliationRequiredMock).toHaveBeenCalledWith(expect.objectContaining({
      reason: expect.stringMatching(/acceptance timestamp/),
    }))
  })

  it("releases a missing-contact reservation because no provider call occurred", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    lookupContactMock.mockResolvedValue(null)

    const response = await POST(request())

    expect(response.status).toBe(422)
    expect(markKnownNotSentMock).toHaveBeenCalled()
    expect(markReconciliationRequiredMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("releases a pre-provider message-preparation failure instead of certifying uncertainty", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    dispatchUnderLockMock.mockResolvedValue({
      kind: "PROVIDER_THREW",
      error: new Error("message database unavailable"),
      providerInvoked: false,
    })

    const response = await POST(request())
    const body = await response.json() as { reconciliationRequired: boolean }

    expect(response.status).toBe(422)
    expect(body.reconciliationRequired).toBe(false)
    expect(markKnownNotSentMock).toHaveBeenCalled()
    expect(markReconciliationRequiredMock).not.toHaveBeenCalled()
  })

  it("locks retry when known-not-sent artifact cleanup cannot complete", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    lookupContactMock.mockResolvedValue(null)
    markKnownNotSentMock.mockRejectedValue(new Error("artifact delete denied"))

    const response = await POST(request())
    const body = await response.json() as { recoveryRequired: boolean; lifecycle: string }

    expect(response.status).toBe(503)
    expect(body).toMatchObject({ recoveryRequired: true })
    expect(body.lifecycle).toBeDefined()
  })

  it("locks a thrown provider call for reconciliation", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    sendMessageMock.mockRejectedValue(new Error("provider-down"))

    const response = await POST(request())

    expect(response.status).toBe(502)
    expect(markReconciliationRequiredMock).toHaveBeenCalled()
    expect(finaliseIssuanceMock).not.toHaveBeenCalled()
  })

  it("fails before reservation when the statutory template is missing or misconfigured", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    messageTemplateFindFirstMock.mockResolvedValue(null)
    expect((await POST(request())).status).toBe(500)
    expect(reserveIssuanceMock).not.toHaveBeenCalled()

    messageTemplateFindFirstMock.mockResolvedValue({ ...template, statutoryOverride: false })
    expect((await POST(request())).status).toBe(500)
    expect(reserveIssuanceMock).not.toHaveBeenCalled()
  })
})
