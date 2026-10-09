/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

// Capture what nodemailer would actually send.
const sendMailMock = vi.fn().mockResolvedValue({ messageId: "m1" })
const createTransportMock = vi.fn((..._a: any[]) => ({ sendMail: sendMailMock }))
vi.mock("nodemailer", () => ({
  default: { createTransport: (...a: any[]) => createTransportMock(...(a as [])) },
}))
function lastTransportOptions(): any {
  return createTransportMock.mock.calls.at(-1)?.[0]
}

const findUniqueMock = vi.fn()
const emailLogCreateMock = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailConfig: { findUnique: (...a: any[]) => findUniqueMock(...a) },
    emailLog: { create: (...a: any[]) => emailLogCreateMock(...a) },
  },
}))

import { graphHttpFailureOutcome, sendEmail } from "./service"

// These suites exercise DISPATCH mechanics against customer@example.com, which
// the recipient allowlist correctly refuses by default (lib/email/recipient-guard.ts).
// Opt out EXPLICITLY rather than adding example.com to the defaults: the point
// of the guard is that a non-production environment reaches nobody it should
// not, and a test fixture is not a reason to widen that. Anyone adding a
// dispatch test has to see this and decide deliberately.
beforeEach(() => {
  process.env.EMAIL_DELIVERY_MODE = "unrestricted"
})
afterEach(() => {
  delete process.env.EMAIL_DELIVERY_MODE
  delete process.env.EMAIL_INTERNAL_DOMAINS
})


const baseConfig = {
  provider: "IMAP_SMTP",
  active: true,
  fromName: "Acme Lending",
  fromAddress: "noreply@lender.example",
  smtpHost: "smtp.lender.example",
  smtpPort: 465,
  smtpUser: "noreply@lender.example",
  smtpPass: "pw",
  useTls: true,
  replyToAddress: null as string | null,
}

const send = (extra: Record<string, unknown> = {}) =>
  sendEmail({ tenantId: "t", to: "customer@example.com", subject: "s", html: "<p>h</p>", ...extra })

describe("sendEmail — recipient header safety", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendMailMock.mockResolvedValue({ messageId: "m1" })
    emailLogCreateMock.mockResolvedValue(undefined)
  })

  it("passes toName as a STRUCTURED address, never string interpolation", async () => {
    // A display name is client-supplied (portal/apply forms). Raw
    // `"name" <addr>` concatenation lets `Sipho" <attacker@evil.test>, "`
    // smuggle a second recipient into the To header — nodemailer's
    // addressparser splits it into two addresses. The structured form is
    // encoded safely by nodemailer and cannot introduce recipients.
    findUniqueMock.mockResolvedValue({ ...baseConfig })
    await send({ toName: 'Sipho" <attacker@evil.test>, "' })
    expect(sendMailMock.mock.calls[0][0].to).toEqual({
      name: 'Sipho" <attacker@evil.test>, "',
      address: "customer@example.com",
    })
  })

  it("passes a bare address when no display name is given", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig })
    await send()
    expect(sendMailMock.mock.calls[0][0].to).toBe("customer@example.com")
  })
})

describe("sendEmail — Reply-To precedence", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendMailMock.mockResolvedValue({ messageId: "m1" })
    emailLogCreateMock.mockResolvedValue(undefined)
  })

  it("uses config.replyToAddress (e.g. support@) as the default when the caller sets none", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig, replyToAddress: "support@lender.example" })
    await send()
    expect(sendMailMock).toHaveBeenCalledOnce()
    expect(sendMailMock.mock.calls[0][0].replyTo).toBe("support@lender.example")
  })

  it("lets an explicit caller Reply-To win over the config default", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig, replyToAddress: "support@lender.example" })
    await send({ replyTo: "someone@lender.example" })
    expect(sendMailMock.mock.calls[0][0].replyTo).toBe("someone@lender.example")
  })

  it("sends no Reply-To header when neither the caller nor the config sets one", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig, replyToAddress: null })
    await send()
    expect(sendMailMock.mock.calls[0][0].replyTo).toBeUndefined()
  })

  it("does NOT apply the config default to Section 129 statutory notices (they must stay no-Reply-To)", async () => {
    // S129 deliberately sends with no Reply-To (anti-spam decision) —
    // it must not inherit the tenant default even when one is configured.
    findUniqueMock.mockResolvedValue({ ...baseConfig, replyToAddress: "support@lender.example" })
    await send({ category: "section129" })
    expect(sendMailMock.mock.calls[0][0].replyTo).toBeUndefined()
  })
})

describe("sendEmail — threading headers", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendMailMock.mockResolvedValue({ messageId: "m1" })
    emailLogCreateMock.mockResolvedValue(undefined)
  })

  it("passes In-Reply-To / References to nodemailer over SMTP", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig })
    await send({ inReplyTo: "<c1@mail>", references: ["<c1@mail>", "<a1@acme>"] })
    const arg = sendMailMock.mock.calls[0][0]
    expect(arg.inReplyTo).toBe("<c1@mail>")
    expect(arg.references).toEqual(["<c1@mail>", "<a1@acme>"])
  })

  it("omits the headers entirely when the caller sets none", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig })
    await send()
    const arg = sendMailMock.mock.calls[0][0]
    expect(arg.inReplyTo).toBeUndefined()
    expect(arg.references).toBeUndefined()
  })

  it("refuses a threaded reply on an MS Graph tenant (synthetic Message-ID can't thread)", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig, provider: "MSGRAPH" })
    const r = await send({ inReplyTo: "<c1@mail>" })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/SMTP/)
    expect(sendMailMock).not.toHaveBeenCalled()
  })
})

describe("sendEmail — provider dispatch boundary", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendMailMock.mockResolvedValue({ messageId: "m1" })
    emailLogCreateMock.mockResolvedValue(undefined)
  })
  afterEach(() => vi.unstubAllGlobals())

  it("signals immediately before SMTP delivery, after configuration is resolved", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig })
    const onProviderDispatchStart = vi.fn(() => {
      expect(findUniqueMock).toHaveBeenCalledOnce()
      expect(sendMailMock).not.toHaveBeenCalled()
    })

    const result = await send({ onProviderDispatchStart })

    expect(onProviderDispatchStart).toHaveBeenCalledOnce()
    expect(onProviderDispatchStart.mock.invocationCallOrder[0])
      .toBeLessThan(sendMailMock.mock.invocationCallOrder[0])
    expect(result.acceptedAt).toBeInstanceOf(Date)
    expect(emailLogCreateMock).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ sentAt: result.acceptedAt }),
    }))
  })

  it("returns accepted SMTP evidence when the auxiliary EmailLog write fails", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig })
    sendMailMock.mockResolvedValue({ messageId: "smtp-accepted-1" })
    emailLogCreateMock.mockRejectedValueOnce(new Error("email log unavailable"))

    const result = await send()

    expect(result).toMatchObject({
      ok: true,
      provider: "SMTP",
      providerOutcome: "ACCEPTED",
      messageId: "smtp-accepted-1",
      emailLogPersistenceError: "email log unavailable",
    })
    expect(result.acceptedAt).toBeInstanceOf(Date)
  })

  it("does not signal when email configuration fails before provider delivery", async () => {
    findUniqueMock.mockResolvedValue(null)
    const onProviderDispatchStart = vi.fn()

    const result = await send({ onProviderDispatchStart })

    expect(result.ok).toBe(false)
    expect(result.providerOutcome).toBe("DEFINITELY_REJECTED")
    expect(onProviderDispatchStart).not.toHaveBeenCalled()
    expect(sendMailMock).not.toHaveBeenCalled()
  })

  it("does not signal for an MS Graph token failure because no message was submitted", async () => {
    findUniqueMock.mockResolvedValue({
      ...baseConfig,
      provider: "MSGRAPH",
      tenantAzureId: "azure-tenant",
      clientId: "client-id",
      clientSecret: "client-secret",
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      text: async () => "token rejected",
    })
    vi.stubGlobal("fetch", fetchMock)
    const onProviderDispatchStart = vi.fn()

    const result = await send({ onProviderDispatchStart })

    expect(result.ok).toBe(false)
    expect(result.providerOutcome).toBe("DEFINITELY_REJECTED")
    expect(fetchMock).toHaveBeenCalledOnce()
    expect(onProviderDispatchStart).not.toHaveBeenCalled()
  })

  it("signals after the MS Graph token succeeds and immediately before sendMail", async () => {
    findUniqueMock.mockResolvedValue({
      ...baseConfig,
      provider: "MSGRAPH",
      tenantAzureId: "azure-tenant",
      clientId: "client-id",
      clientSecret: "client-secret",
    })
    const phases: string[] = []
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ access_token: "token" }),
      })
      .mockImplementationOnce(async () => {
        phases.push("send-mail")
        return { ok: true, status: 202, headers: new Headers() }
      })
    vi.stubGlobal("fetch", fetchMock)
    const onProviderDispatchStart = vi.fn(() => phases.push("provider-boundary"))

    const result = await send({ onProviderDispatchStart })

    expect(result.ok).toBe(true)
    expect(result.providerOutcome).toBe("ACCEPTED")
    expect(result.acceptedAt).toBeInstanceOf(Date)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(phases).toEqual(["provider-boundary", "send-mail"])
    expect(result.providerEvidenceReference).toMatch(
      /^MSGRAPH_CLIENT_REQUEST_ID:[0-9a-f-]{36}$/,
    )
    expect(fetchMock.mock.calls[1][1].headers).toEqual(expect.objectContaining({
      "return-client-request-id": "true",
      "client-request-id": expect.stringMatching(/^[0-9a-f-]{36}$/),
    }))
  })

  it("returns accepted Graph request evidence when the auxiliary EmailLog write fails", async () => {
    findUniqueMock.mockResolvedValue({
      ...baseConfig,
      provider: "MSGRAPH",
      tenantAzureId: "azure-tenant",
      clientId: "client-id",
      clientSecret: "client-secret",
    })
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) })
      .mockResolvedValueOnce({
        ok: true,
        status: 202,
        headers: new Headers({ "request-id": "graph-request-1" }),
      }))
    emailLogCreateMock.mockRejectedValueOnce(new Error("email log unavailable"))

    const result = await send()

    expect(result).toMatchObject({
      ok: true,
      provider: "MSGRAPH",
      providerOutcome: "ACCEPTED",
      emailLogPersistenceError: "email log unavailable",
    })
    expect(result.acceptedAt).toBeInstanceOf(Date)
    expect(result.providerEvidenceReference).toMatch(
      /^MSGRAPH_REQUEST_ID:graph-request-1;CLIENT_REQUEST_ID:[0-9a-f-]{36}$/,
    )
  })

  it("classifies an explicit Graph 4xx sendMail response as definitely rejected", async () => {
    findUniqueMock.mockResolvedValue({
      ...baseConfig,
      provider: "MSGRAPH",
      tenantAzureId: "azure-tenant",
      clientId: "client-id",
      clientSecret: "client-secret",
    })
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) })
      .mockResolvedValueOnce({ ok: false, status: 400, text: async () => "bad recipient" }))

    const result = await send()

    expect(result).toMatchObject({ ok: false, providerOutcome: "DEFINITELY_REJECTED" })
  })

  it("holds Graph HTTP 408/409 for reconciliation because acceptance is unknown", () => {
    expect(graphHttpFailureOutcome(408)).toBe("AMBIGUOUS")
    expect(graphHttpFailureOutcome(409)).toBe("AMBIGUOUS")
  })

  it("classifies a Graph 5xx response as ambiguous after submission", async () => {
    findUniqueMock.mockResolvedValue({
      ...baseConfig,
      provider: "MSGRAPH",
      tenantAzureId: "azure-tenant",
      clientId: "client-id",
      clientSecret: "client-secret",
    })
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "token" }) })
      .mockResolvedValueOnce({ ok: false, status: 503, text: async () => "gateway timeout" }))

    const result = await send()

    expect(result).toMatchObject({ ok: false, providerOutcome: "AMBIGUOUS" })
  })

  it("classifies an SMTP response-code rejection as definitely rejected", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig })
    sendMailMock.mockRejectedValue(Object.assign(new Error("mailbox unavailable"), { responseCode: 550 }))

    const result = await send()

    expect(result).toMatchObject({ ok: false, providerOutcome: "DEFINITELY_REJECTED" })
  })

  // Seam test: smtp-failure.test.ts proves the classifier against real
  // nodemailer; this proves sendViaSMTP consults it. Without it the call could
  // be deleted and every connect failure would go back to reconciliation.
  it("classifies an SMTP failure before any connection existed as definitely rejected", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig })
    sendMailMock.mockRejectedValue(Object.assign(new Error("Connection timeout"), { code: "ETIMEDOUT", command: "CONN" }))

    const result = await send()

    expect(result).toMatchObject({ ok: false, providerOutcome: "DEFINITELY_REJECTED" })
  })

  it("classifies a generic SMTP failure after sendMail begins as ambiguous", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig })
    sendMailMock.mockRejectedValue(new Error("socket reset"))

    const result = await send()

    expect(result).toMatchObject({ ok: false, providerOutcome: "AMBIGUOUS" })
  })
})

describe("sendEmail — the recipient allowlist is actually wired in", () => {
  // The guard has its own unit tests. Those prove the FUNCTION is correct; they
  // do not prove sendEmail calls it. This is the seam test — without it the
  // guard could be deleted from service.ts and every other test would stay
  // green. See "a dispatch seam needs a real test".
  beforeEach(() => {
    delete process.env.EMAIL_DELIVERY_MODE // restricted, as a fresh environment would be
    process.env.EMAIL_INTERNAL_DOMAINS = "lender.example"
    findUniqueMock.mockResolvedValue({ ...baseConfig })
    // mockReset, not mockClear. An earlier suite sets a PERSISTENT
    // sendMailMock.mockRejectedValue("socket reset"); mockClear wipes the call
    // list but leaves that implementation in place, so this suite inherited a
    // transport that always throws and the allowlisted-delivery case failed for
    // a reason that had nothing to do with the guard.
    sendMailMock.mockReset()
    sendMailMock.mockResolvedValue({ messageId: "m1" })
    emailLogCreateMock.mockReset()
    emailLogCreateMock.mockResolvedValue({})
  })

  it("refuses a real public mailbox and NEVER reaches the provider", async () => {
    const res = await sendEmail({
      tenantId: "t1",
      to: "blocked.recipient@outlook.com",
      subject: "Section 129 Notice",
      html: "<p>notice</p>",
      category: "section129",
    })
    expect(res.ok).toBe(false)
    expect(res.providerOutcome).toBe("DEFINITELY_REJECTED")
    // The assertion that matters: nothing was handed to the transport.
    expect(sendMailMock).not.toHaveBeenCalled()
  })

  it("records the refusal as BLOCKED, so it is visible rather than silent", async () => {
    await sendEmail({
      tenantId: "t1",
      to: "blocked.recipient@gmail.com",
      subject: "Section 129 Notice",
      html: "<p>notice</p>",
      category: "section129",
    })
    expect(emailLogCreateMock).toHaveBeenCalledTimes(1)
    const row = emailLogCreateMock.mock.calls[0][0].data
    expect(row.status).toBe("BLOCKED")
    expect(row.toAddress).toBe("blocked.recipient@gmail.com")
    expect(row.category).toBe("section129")
    expect(row.errorMessage).toContain("gmail.com")
  })

  it("still delivers to an allowlisted domain, so the guard is not a blanket off-switch", async () => {
    const res = await sendEmail({
      tenantId: "t1",
      to: "ops@lender.example",
      subject: "internal",
      html: "<p>hi</p>",
    })
    expect(res.ok).toBe(true)
    expect(sendMailMock).toHaveBeenCalledTimes(1)
  })
})

describe("sendEmail — redactedBodyPlaceholder (EmailLog body secrecy)", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    sendMailMock.mockResolvedValue({ messageId: "m1" })
    emailLogCreateMock.mockResolvedValue(undefined)
    findUniqueMock.mockResolvedValue({ ...baseConfig })
  })

  const OTP_HTML = "<p>Your code is <b>483920</b></p>"

  it("stores the placeholder in EmailLog while the PROVIDER still gets the true body", async () => {
    await send({ html: OTP_HTML, redactedBodyPlaceholder: "[redacted]" })

    // The recipient must still receive a usable email.
    const sent = sendMailMock.mock.calls[0][0]
    expect(sent.html).toBe(OTP_HTML)

    const row = emailLogCreateMock.mock.calls[0][0].data
    expect(row.bodyHtml).toBe("[redacted]")
    expect(row.bodyText).toBe("[redacted]")
  })

  it("leaves no trace of the secret anywhere on the EmailLog row", async () => {
    await send({ html: OTP_HTML, redactedBodyPlaceholder: "[redacted]" })

    const row = emailLogCreateMock.mock.calls[0][0].data
    expect(JSON.stringify(row)).not.toContain("483920")
  })

  it("suppresses the DERIVED text alternative too, not just bodyHtml", async () => {
    // sendEmail derives `text` from the html when the caller passes none. A
    // fix that only redacted bodyHtml would leak the whole code via bodyText.
    await send({ html: OTP_HTML, text: undefined, redactedBodyPlaceholder: "[redacted]" })

    expect(emailLogCreateMock.mock.calls[0][0].data.bodyText).toBe("[redacted]")
  })

  it("redacts the BLOCKED-recipient refusal row — the likeliest path to fire", async () => {
    // The recipient guard exists because this case recurs, and its comment
    // requires refusals to be RECORDED. Recorded, yes; recorded with a live
    // OTP in plaintext, no. This path never reaches a provider, so the row is
    // the ONLY artefact it produces.
    delete process.env.EMAIL_DELIVERY_MODE // re-arm the allowlist

    const r = await send({ html: OTP_HTML, redactedBodyPlaceholder: "[redacted]" })

    expect(r.ok).toBe(false)
    expect(sendMailMock).not.toHaveBeenCalled()
    const row = emailLogCreateMock.mock.calls[0][0].data
    expect(row.status).toBe("BLOCKED")
    expect(row.bodyHtml).toBe("[redacted]")
    expect(row.bodyText).toBe("[redacted]")
    expect(JSON.stringify(row)).not.toContain("483920")
  })

  it("redacts the provider-changed-before-dispatch failure row", async () => {
    // Fires BEFORE dispatch, so the body it holds is the full unsent payload.
    const r = await send({
      html: OTP_HTML,
      redactedBodyPlaceholder: "[redacted]",
      expectedProvider: "MSGRAPH",
    })

    expect(r.ok).toBe(false)
    expect(sendMailMock).not.toHaveBeenCalled()
    const row = emailLogCreateMock.mock.calls[0][0].data
    expect(row.status).toBe("FAILED")
    expect(row.bodyHtml).toBe("[redacted]")
    expect(row.bodyText).toBe("[redacted]")
    expect(JSON.stringify(row)).not.toContain("483920")
  })

  it("redacts the derived text on the refusal paths too, not only bodyHtml", async () => {
    // Both refusal sites reconstruct text via `opts.text ?? htmlToPlainText`,
    // which rebuilds the code from the HTML exactly as `enriched.text` did.
    const r = await send({
      html: OTP_HTML,
      text: undefined,
      redactedBodyPlaceholder: "[redacted]",
      expectedProvider: "MSGRAPH",
    })

    expect(r.ok).toBe(false)
    expect(emailLogCreateMock.mock.calls[0][0].data.bodyText).toBe("[redacted]")
  })

  it("logs the real body on the refusal paths when no placeholder is supplied", async () => {
    const r = await send({ html: OTP_HTML, expectedProvider: "MSGRAPH" })

    expect(r.ok).toBe(false)
    const row = emailLogCreateMock.mock.calls[0][0].data
    expect(row.bodyHtml).toBe(OTP_HTML)
    expect(row.bodyText).toContain("483920")
  })

  it("logs the real body when no placeholder is supplied", async () => {
    await send({ html: OTP_HTML })

    const row = emailLogCreateMock.mock.calls[0][0].data
    expect(row.bodyHtml).toBe(OTP_HTML)
    expect(row.bodyText).toContain("483920")
  })
})

describe("sendEmail — secrets at rest", () => {
  const KEY = Buffer.alloc(32, 3).toString("base64")

  beforeEach(() => {
    vi.clearAllMocks()
    sendMailMock.mockResolvedValue({ messageId: "m1" })
    emailLogCreateMock.mockResolvedValue(undefined)
  })
  afterEach(() => {
    delete process.env.WABA_ENC_KEY
  })

  it("unseals a sealed smtpPass before handing it to nodemailer", async () => {
    process.env.WABA_ENC_KEY = KEY
    const { sealSecret } = await import("@/lib/crypto/secret-box")
    findUniqueMock.mockResolvedValue({ ...baseConfig, smtpPass: sealSecret("real-pw", KEY) })
    await send()
    // The transport is created per send; assert via the auth we passed through.
    expect(sendMailMock).toHaveBeenCalled()
    expect(lastTransportOptions()?.auth?.pass).toBe("real-pw")
  })

  it("TOLERANT READ — a legacy plaintext smtpPass still sends", async () => {
    findUniqueMock.mockResolvedValue({ ...baseConfig, smtpPass: "legacy-pw" })
    await send()
    expect(lastTransportOptions()?.auth?.pass).toBe("legacy-pw")
  })

  it("a sealed smtpPass with no WABA_ENC_KEY is DEFINITELY_REJECTED, never reaches nodemailer, and logs FAILED not AMBIGUOUS", async () => {
    const SEALING_KEY = Buffer.alloc(32, 4).toString("base64")
    const { sealSecret } = await import("@/lib/crypto/secret-box")
    findUniqueMock.mockResolvedValue({ ...baseConfig, smtpPass: sealSecret("real-pw", SEALING_KEY) })
    // WABA_ENC_KEY intentionally left unset — openField must throw.

    const result = await send()

    expect(result.ok).toBe(false)
    expect(result.providerOutcome).toBe("DEFINITELY_REJECTED")
    expect(result.error).toBe("Stored email credential could not be decrypted (check WABA_ENC_KEY)")
    expect(createTransportMock).not.toHaveBeenCalled()
    // Mirrors the sibling "SMTP config incomplete" arm — an early return
    // before the provider boundary, so no EmailLog row is written here (never
    // AMBIGUOUS, which would be the wrong failure but IS what happens without
    // this fix, once the uncaught throw propagates past sendEmail entirely).
    expect(emailLogCreateMock).not.toHaveBeenCalled()
  })

  it("a sealed clientSecret with no WABA_ENC_KEY is DEFINITELY_REJECTED, never reaches Graph fetch", async () => {
    const SEALING_KEY = Buffer.alloc(32, 4).toString("base64")
    const { sealSecret } = await import("@/lib/crypto/secret-box")
    findUniqueMock.mockResolvedValue({
      ...baseConfig,
      provider: "MSGRAPH",
      tenantAzureId: "azure-tenant",
      clientId: "client-id",
      clientSecret: sealSecret("real-secret", SEALING_KEY),
    })
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)

    const result = await send()

    expect(result.ok).toBe(false)
    expect(result.providerOutcome).toBe("DEFINITELY_REJECTED")
    expect(result.error).toBe("Stored email credential could not be decrypted (check WABA_ENC_KEY)")
    expect(fetchMock).not.toHaveBeenCalled()
    expect(emailLogCreateMock).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })
})
