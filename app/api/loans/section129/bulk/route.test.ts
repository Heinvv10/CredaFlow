import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { NextResponse } from "next/server"
import { parseLenderIdentity } from "@/lib/config/identity"
import { VALID_LENDER_COLUMNS } from "@/lib/config/__fixtures__/lender-identity"

const requireApiRoleMock = vi.fn()
const lenderIdentityMock = vi.fn()
const loanFindManyMock = vi.fn()
const messageTemplateFindFirstMock = vi.fn()
const sendEmailMock = vi.fn()
const sendMessageMock = vi.fn()
const lookupContactMock = vi.fn()
const logAuditMock = vi.fn()
const reserveIssuanceMock = vi.fn()
const dispatchUnderLockMock = vi.fn()
const markKnownNotSentMock = vi.fn()
const markReconciliationRequiredMock = vi.fn()
const finaliseIssuanceMock = vi.fn()

const { settlementFiguresMock } = vi.hoisted(() => ({ settlementFiguresMock: vi.fn() }))
// No tenant logo: documents print the text letterhead (lib/config/lender-logo.ts).
vi.mock("@/lib/config/lender-logo", () => ({ getLenderLogo: async () => undefined }))
vi.mock("@/lib/loan/charges-summary", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/loan/charges-summary")>()),
  loanSettlementFigures: (...args: unknown[]) => settlementFiguresMock(...args),
}))
vi.mock("@/lib/config/identity-response", () => ({
  lenderIdentityOrRefusal: (tenantId: string) => lenderIdentityMock(tenantId),
}))
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (role: unknown) => requireApiRoleMock(role),
  // act_on_collections itself is proved with the real guards in app/api/collections-scope-rbac.test.ts.
  canDo: () => true,
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (tenant: { id: string; name?: string }) => Promise<unknown>) =>
    cb({ id: "tenant_acme", name: "Acme Lending" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loan: { findMany: (args: unknown) => loanFindManyMock(args) },
    messageTemplate: { findFirst: (args: unknown) => messageTemplateFindFirstMock(args) },
    emailConfig: { findUnique: async () => null },
    // A seeded demo lender (TenantConfig.isDemoLender): the demo transport's second gate.
    tenantConfig: { findUnique: async () => ({ isDemoLender: true }) },
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

import { Section129IssuanceConflictError } from "@/lib/collections/section129-artifact"
import { ProviderDispatchError } from "@/lib/messaging/providers"
import { POST } from "./route"
import { formatZAR } from "@/lib/utils"

const sampleLoan = {
  id: "loan_1",
  clientId: "cl_1",
  status: "DEFAULTED",
  reference: "L-001",
  arrearsAmount: 1_234_567,
  outstandingPrincipal: 5_000_000,
  daysInArrears: 95,
  client: {
    id: "cl_1",
    firstName: "Test",
    lastName: "Client",
    idNumber: "9001015000088",
    email: "client@example.com",
    addressLine1: null,
    city: null,
  },
}
const sampleTemplate = {
  id: "tpl_s129",
  key: "section129_email",
  channel: "EMAIL",
  statutoryOverride: true,
}
const providerAcceptedAt = new Date("2026-07-19T10:00:00.000Z")
function reservation(loanId = "loan_1") {
  return {
    issuanceId: `issue-${loanId}`,
    idempotencyKey: `tenant_acme:SECTION_129_NOTICE:${loanId}`,
    pdfSha256: "a".repeat(64),
    recordData: { lifecycle: "READY", noticeDate: "19 July 2026" },
  }
}
function request() {
  return new NextRequest("https://staging.example.test/api/loans/section129/bulk", { method: "POST" })
}

beforeEach(() => {
  vi.clearAllMocks()
  delete process.env.MESSAGING_NEW_SEND_S129
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "officer@x" } })
  // No default charges: the notice states the loan's own figures.
  settlementFiguresMock.mockImplementation(async (_db: unknown, l: { arrearsAmount: number; outstandingPrincipal: number }) => ({
    live: false, charges: null, chargeLines: [], chargesOutstanding: 0, interestAndFeesOutstanding: 0,
    totalToSettle: l.outstandingPrincipal, arrearsIncludingCharges: l.arrearsAmount,
  }))
  loanFindManyMock.mockResolvedValue([sampleLoan])
  messageTemplateFindFirstMock.mockResolvedValue(sampleTemplate)
  sendEmailMock.mockResolvedValue({ ok: true, messageId: "mail-1", providerOutcome: "ACCEPTED", acceptedAt: providerAcceptedAt })
  sendMessageMock.mockResolvedValue({ id: "msg-1", providerMessageId: "provider-1", sentAt: providerAcceptedAt })
  lookupContactMock.mockResolvedValue({ id: "contact-1" })
  // As the real one: a simulated send is recorded on the reservation.
  reserveIssuanceMock.mockImplementation((args: { loanId: string; simulated?: boolean }) => {
    const reserved = reservation(args.loanId)
    return Promise.resolve(args.simulated ? { ...reserved, recordData: { ...reserved.recordData, simulated: true } } : reserved)
  })
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
  lenderIdentityMock.mockResolvedValue({ identity: parseLenderIdentity(VALID_LENDER_COLUMNS) })
})

afterEach(() => {
  delete process.env.MESSAGING_NEW_SEND_S129
  vi.unstubAllEnvs()
})

describe("POST /api/loans/section129/bulk", () => {
  // no configured, valid lender identity ⇒ no notice in the batch.
  it("refuses with 409 before reading loans when the lender identity is not configured", async () => {
    lenderIdentityMock.mockResolvedValue({
      refusal: NextResponse.json({ code: "LENDER_IDENTITY_NOT_CONFIGURED" }, { status: 409 }),
    })
    const response = await POST(request())
    expect(response.status).toBe(409)
    expect(loanFindManyMock).not.toHaveBeenCalled()
    expect(reserveIssuanceMock).not.toHaveBeenCalled()
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("reserves, sends and finalises each legacy-path notice", async () => {
    const response = await POST(request())
    const body = await response.json()

    expect(body).toMatchObject({ ok: true, sent: 1, failed: 0, skipped: 0 })
    expect(reserveIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({ loanId: "loan_1", bulk: true }))
    expect(dispatchUnderLockMock.mock.invocationCallOrder[0]).toBeLessThan(sendEmailMock.mock.invocationCallOrder[0])
    expect(finaliseIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({
      loanId: "loan_1",
      emailMessageId: "mail-1",
      issuedAt: providerAcceptedAt,
    }))
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  // Charges off: an s125-priced loan's notice states what settles it today,
  // not the principal alone (Fair Score audit 2026-10-19).
  it("states the settlement figure as the total obligation in the notice, email and record", async () => {
    settlementFiguresMock.mockImplementation(async (_db: unknown, l: { arrearsAmount: number; outstandingPrincipal: number }) => ({
      live: false, charges: null, chargeLines: [], chargesOutstanding: 0, interestAndFeesOutstanding: 80_000,
      totalToSettle: l.outstandingPrincipal + 80_000, arrearsIncludingCharges: l.arrearsAmount, s125Priced: true,
    }))
    await POST(request())
    expect(reserveIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({ totalOutstanding: 5_080_000 }))
    expect(JSON.stringify(sendEmailMock.mock.calls[0])).toContain(formatZAR(5_080_000))
  })

  it("records each .invalid mailbox's notice as simulated (not sent) on a demo stack", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    loanFindManyMock.mockResolvedValue([{ ...sampleLoan, client: { ...sampleLoan.client, email: "kabelo@fairscore.invalid" } }])
    const body = await (await POST(request())).json()
    expect(body).toMatchObject({ ok: true, sent: 1, results: [expect.objectContaining({ outcome: "SENT", simulated: true })] })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(reserveIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({ simulated: true }))
    expect(finaliseIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({ simulated: true }))
  })

  it("locks a provider failure for reconciliation and continues the batch", async () => {
    loanFindManyMock.mockResolvedValue([
      sampleLoan,
      { ...sampleLoan, id: "loan_2", reference: "L-002" },
    ])
    sendEmailMock
      .mockResolvedValueOnce({ ok: false, error: "smtp-unknown", providerOutcome: "AMBIGUOUS" })
      .mockResolvedValueOnce({ ok: true, messageId: "mail-2", providerOutcome: "ACCEPTED", acceptedAt: providerAcceptedAt })

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ sent: 1, failed: 1, skipped: 0 })
    expect(body.failures[0]).toContain("reconciliation required")
    expect(markReconciliationRequiredMock).toHaveBeenCalledTimes(1)
    expect(finaliseIssuanceMock).toHaveBeenCalledTimes(1)
  })

  it("releases an explicit provider rejection without requiring reconciliation", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    sendMessageMock.mockRejectedValue(
      new ProviderDispatchError("recipient rejected", "DEFINITELY_REJECTED"),
    )

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ sent: 0, failed: 1, reconciliationRequired: 0 })
    expect(body.results[0]).toMatchObject({ outcome: "FAILED", error: "recipient rejected" })
    expect(markKnownNotSentMock).toHaveBeenCalledWith(expect.objectContaining({
      reason: "recipient rejected",
    }))
    expect(markReconciliationRequiredMock).not.toHaveBeenCalled()
  })

  it("reports a non-retryable recovery item when known-not-sent cleanup fails", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    lookupContactMock.mockResolvedValue(null)
    markKnownNotSentMock.mockRejectedValue(new Error("artifact delete denied"))

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ ok: false, sent: 0, failed: 1, recoveryRequired: 1 })
    expect(body.results[0]).toMatchObject({
      outcome: "RECOVERY_REQUIRED",
      issuanceId: "issue-loan_1",
    })
  })

  it("uses the message pipeline when enabled and attaches a real PDF", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ sent: 1, failed: 0 })
    expect(sendEmailMock).not.toHaveBeenCalled()
    const send = sendMessageMock.mock.calls[0][0]
    expect(send).toMatchObject({ contactId: "contact-1", category: "section129", loanId: "loan_1" })
    const pdf = send.attachments.find((attachment: { contentType?: string }) => attachment.contentType === "application/pdf")
    expect(pdf.content.subarray(0, 4).toString("ascii")).toBe("%PDF")
    expect(finaliseIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({
      emailMessageId: "provider-1",
      issuedAt: providerAcceptedAt,
    }))
  })

  it("stores legacy Graph request evidence even when EmailLog persistence fails", async () => {
    const providerEvidenceReference =
      "MSGRAPH_CLIENT_REQUEST_ID:00000000-0000-4000-8000-000000000020"
    sendEmailMock.mockResolvedValue({
      ok: true,
      providerOutcome: "ACCEPTED",
      acceptedAt: providerAcceptedAt,
      providerEvidenceReference,
      emailLogPersistenceError: "database unavailable",
    })

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ sent: 1, failed: 0 })
    expect(finaliseIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({
      providerEvidenceReference,
      providerPersistenceWarning:
        "EmailLog persistence failed after provider acceptance: database unavailable",
      issuedAt: providerAcceptedAt,
    }))
  })

  it("preserves a known provider acceptance after Message persistence fails", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    const providerEvidenceReference =
      "MSGRAPH_CLIENT_REQUEST_ID:00000000-0000-4000-8000-000000000021"
    sendMessageMock.mockRejectedValue(Object.assign(new Error("terminal writes failed"), {
      name: "KnownDispatchPersistenceError",
      outcome: "PROVIDER_ACCEPTED",
      providerAcceptedAt,
      evidenceReference: providerEvidenceReference,
      evidenceAuditWriteError: undefined,
    }))

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ sent: 1, failed: 0 })
    expect(finaliseIssuanceMock).toHaveBeenCalledWith(expect.objectContaining({
      providerEvidenceReference,
      emergencyEvidenceAuditPersisted: true,
      issuedAt: providerAcceptedAt,
    }))
  })

  it("queues reconciliation rather than inventing a timestamp for an accepted notice", async () => {
    sendEmailMock.mockResolvedValue({ ok: true, messageId: "mail-1", providerOutcome: "ACCEPTED" })

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ sent: 0, failed: 1, reconciliationRequired: 1 })
    expect(body.results[0]).toMatchObject({ outcome: "RECONCILIATION_REQUIRED" })
    expect(finaliseIssuanceMock).not.toHaveBeenCalled()
  })

  it("releases a reservation when contact lookup fails before provider invocation", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    lookupContactMock.mockResolvedValue(null)

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ sent: 0, failed: 1 })
    expect(markKnownNotSentMock).toHaveBeenCalledOnce()
    expect(markReconciliationRequiredMock).not.toHaveBeenCalled()
    expect(sendMessageMock).not.toHaveBeenCalled()
  })

  it("counts active reservation/cooldown conflicts as skipped, never sent", async () => {
    reserveIssuanceMock.mockRejectedValue(
      new Section129IssuanceConflictError("already issued", "issue-old", "ISSUED"),
    )

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ sent: 0, failed: 0, skipped: 1 })
    expect(sendEmailMock).not.toHaveBeenCalled()
  })

  it("counts a locked operative-snapshot change as skipped, never failed or sent", async () => {
    dispatchUnderLockMock.mockResolvedValue({
      kind: "SNAPSHOT_CHANGED",
      error: new Error("operative notice snapshot changed"),
    })

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ sent: 0, failed: 0, skipped: 1 })
    expect(body.results[0]).toMatchObject({ outcome: "SKIPPED" })
    expect(sendEmailMock).not.toHaveBeenCalled()
    expect(markKnownNotSentMock).not.toHaveBeenCalled()
    expect(markReconciliationRequiredMock).not.toHaveBeenCalled()
  })

  it("requires reconciliation if provider delivery succeeds but finalisation fails", async () => {
    finaliseIssuanceMock.mockRejectedValue(new Error("db-down"))

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ sent: 0, failed: 1 })
    expect(body.failures[0]).toContain("reconciliation required")
    expect(markReconciliationRequiredMock).toHaveBeenCalled()
  })

  it("continues reporting a non-retryable outcome when reconciliation promotion also fails", async () => {
    sendEmailMock.mockResolvedValue({ ok: false, error: "provider-unknown", providerOutcome: "AMBIGUOUS" })
    markReconciliationRequiredMock.mockRejectedValue(new Error("db-still-down"))

    const body = await (await POST(request())).json()

    expect(body).toMatchObject({ ok: false, sent: 0, failed: 1, reconciliationRequired: 1 })
    expect(body.results[0]).toMatchObject({ outcome: "RECONCILIATION_REQUIRED", issuanceId: "issue-loan_1" })
  })

  it("fails the batch before reservation when the statutory template is absent or unsafe", async () => {
    process.env.MESSAGING_NEW_SEND_S129 = "true"
    messageTemplateFindFirstMock.mockResolvedValue(null)
    expect((await POST(request())).status).toBe(500)
    expect(reserveIssuanceMock).not.toHaveBeenCalled()

    messageTemplateFindFirstMock.mockResolvedValue({ ...sampleTemplate, statutoryOverride: false })
    expect((await POST(request())).status).toBe(500)
    expect(reserveIssuanceMock).not.toHaveBeenCalled()
  })

  it("queries only server-eligible 90+ DPD, positive-balance loan states", async () => {
    await POST(request())

    expect(loanFindManyMock).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        daysInArrears: { gte: 90 },
        arrearsAmount: { gt: 0 },
        outstandingPrincipal: { gt: 0 },
        status: { in: ["ACTIVE", "DEFAULTED"] },
      }),
    }))
  })
})
