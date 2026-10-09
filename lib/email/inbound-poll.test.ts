/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"

const connectMock = vi.fn()
const noopMock = vi.fn()
const statusMock = vi.fn()
const logoutMock = vi.fn()
const fetchMock = vi.fn()
const getMailboxLockMock = vi.fn()
const imapCtorMock = vi.fn()

vi.mock("imapflow", () => ({
  ImapFlow: class {
    constructor(opts: unknown) {
      imapCtorMock(opts)
    }
    connect = connectMock
    noop = noopMock
    status = statusMock
    logout = logoutMock
    getMailboxLock = getMailboxLockMock
    fetch = fetchMock
  },
}))

const emailConfigUpdateMock = vi.fn()
const emailConfigFindUniqueMock = vi.fn()
vi.mock("@/lib/prisma", () => ({
  prisma: {
    emailConfig: {
      update: (...a: any[]) => emailConfigUpdateMock(...a),
      findUnique: (...a: any[]) => emailConfigFindUniqueMock(...a),
    },
  },
}))
vi.mock("./record-inbound", () => ({
  recordEmailReply: vi.fn().mockResolvedValue(false),
  recordInboundEmailMessage: vi.fn().mockResolvedValue(undefined),
}))

import { pollTenantInbox, testImapLogin } from "./inbound-poll"

const config = {
  provider: "IMAP_SMTP",
  fromAddress: "noreply@lender.example",
  tenantAzureId: null,
  clientId: null,
  clientSecret: null,
  imapHost: "imap.mailtrap.io",
  imapPort: 993,
  imapUser: "u",
  imapPass: "pw",
  useTls: true,
}

beforeEach(() => {
  vi.clearAllMocks()
  process.env.EMAIL_DELIVERY_MODE = "unrestricted"
  emailConfigUpdateMock.mockResolvedValue({})
  connectMock.mockResolvedValue(undefined)
  logoutMock.mockResolvedValue(undefined)
  noopMock.mockResolvedValue(undefined)
  statusMock.mockResolvedValue({ messages: 3 })
  getMailboxLockMock.mockResolvedValue({ release: vi.fn() })
  fetchMock.mockReturnValue((async function* () {})())
})
afterEach(() => {
  delete process.env.EMAIL_DELIVERY_MODE
  delete process.env.EMAIL_INBOUND_ALLOWED_HOSTS
  delete process.env.WABA_ENC_KEY
})

describe("pollTenantInbox — persisted outcome", () => {
  it("records a successful poll on EmailConfig", async () => {
    const r = await pollTenantInbox(config as any, "t1")
    expect(r.ok).toBe(true)
    expect(emailConfigUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { tenantId: "t1" },
        data: expect.objectContaining({ lastPollOk: true, lastPollError: null }),
      }),
    )
  })

  it("records a failed poll WITH the error message", async () => {
    connectMock.mockRejectedValue(new Error("wrong version number"))
    const r = await pollTenantInbox(config as any, "t1")
    expect(r.ok).toBe(false)
    const data = emailConfigUpdateMock.mock.calls.at(-1)?.[0].data
    expect(data.lastPollOk).toBe(false)
    expect(data.lastPollError).toContain("wrong version number")
  })

  it("truncates a huge provider error to 512 chars", async () => {
    connectMock.mockRejectedValue(new Error("x".repeat(2000)))
    await pollTenantInbox(config as any, "t1")
    expect(emailConfigUpdateMock.mock.calls.at(-1)?.[0].data.lastPollError.length).toBe(512)
  })

  it("a persistence failure does not turn a successful poll into a failure", async () => {
    emailConfigUpdateMock.mockRejectedValue(new Error("db down"))
    const r = await pollTenantInbox(config as any, "t1")
    expect(r.ok).toBe(true)
  })

  it("redacts the password out of a leaked provider error before persisting", async () => {
    connectMock.mockRejectedValue(new Error("Invalid credentials for pw"))
    const r = await pollTenantInbox(config as any, "t1")
    expect(r.ok).toBe(false)
    expect(r.message).not.toContain("pw")
    expect(r.message).toContain("[redacted]")
    const data = emailConfigUpdateMock.mock.calls.at(-1)?.[0].data
    expect(data.lastPollError).not.toContain("pw")
    expect(data.lastPollError).toContain("[redacted]")
  })
})

const graphConfig = {
  provider: "MSGRAPH",
  fromAddress: "noreply@lender.example",
  tenantAzureId: "azure-tenant",
  clientId: "client-id",
  clientSecret: "client-secret",
  imapHost: null,
  imapPort: null,
  imapUser: null,
  imapPass: null,
  useTls: true,
}

describe("pollTenantInbox — Graph restricted-mode guard", () => {
  it("refuses to poll in restricted mode before making any HTTP request", async () => {
    delete process.env.EMAIL_DELIVERY_MODE
    const globalFetchSpy = vi.fn()
    vi.stubGlobal("fetch", globalFetchSpy)

    const r = await pollTenantInbox(graphConfig as any, "t1")

    expect(r.ok).toBe(false)
    expect(r.message).toBe(
      "Graph inbound polling is disabled in this environment (EMAIL_DELIVERY_MODE is not unrestricted).",
    )
    expect(globalFetchSpy).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it("polls when EMAIL_DELIVERY_MODE is unrestricted", async () => {
    process.env.EMAIL_DELIVERY_MODE = "unrestricted"
    const globalFetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ access_token: "tok" }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ value: [] }) })
    vi.stubGlobal("fetch", globalFetchSpy)

    const r = await pollTenantInbox(graphConfig as any, "t1")

    expect(r.ok).toBe(true)
    expect(globalFetchSpy).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })
})

describe("pollTenantInbox — Graph HTTP failure handling", () => {
  beforeEach(() => {
    process.env.EMAIL_DELIVERY_MODE = "unrestricted"
  })

  it("reports a failed token request without an access_token", async () => {
    const globalFetchSpy = vi.fn().mockResolvedValueOnce({ ok: false, status: 401, json: async () => ({}) })
    vi.stubGlobal("fetch", globalFetchSpy)

    const r = await pollTenantInbox(graphConfig as any, "t1")

    expect(r.ok).toBe(false)
    expect(r.message).toBe("Graph token request failed (HTTP 401)")
    expect(globalFetchSpy).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it("reports a token response with ok:true but no access_token", async () => {
    const globalFetchSpy = vi.fn().mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({}) })
    vi.stubGlobal("fetch", globalFetchSpy)

    const r = await pollTenantInbox(graphConfig as any, "t1")

    expect(r.ok).toBe(false)
    expect(r.message).toBe("Graph token request failed (HTTP 200)")
    expect(globalFetchSpy).toHaveBeenCalledTimes(1)
    vi.unstubAllGlobals()
  })

  it("reports a failed inbox request", async () => {
    const globalFetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ access_token: "tok" }) })
      .mockResolvedValueOnce({ ok: false, status: 503, json: async () => ({}) })
    vi.stubGlobal("fetch", globalFetchSpy)

    const r = await pollTenantInbox(graphConfig as any, "t1")

    expect(r.ok).toBe(false)
    expect(r.message).toBe("Graph inbox request failed (HTTP 503)")
    expect(globalFetchSpy).toHaveBeenCalledTimes(2)
    vi.unstubAllGlobals()
  })
})

describe("pollTenantInbox — inbound host guard", () => {
  it("refuses to connect to an unlisted host in restricted mode", async () => {
    delete process.env.EMAIL_DELIVERY_MODE
    process.env.EMAIL_INBOUND_ALLOWED_HOSTS = "imap.other.test"
    const r = await pollTenantInbox(config as any, "t1")
    expect(r.ok).toBe(false)
    expect(r.message).toContain("EMAIL_INBOUND_ALLOWED_HOSTS")
    expect(connectMock).not.toHaveBeenCalled()
  })

  it("connects when the host is listed", async () => {
    delete process.env.EMAIL_DELIVERY_MODE
    process.env.EMAIL_INBOUND_ALLOWED_HOSTS = "imap.mailtrap.io"
    const r = await pollTenantInbox(config as any, "t1")
    expect(r.ok).toBe(true)
    expect(connectMock).toHaveBeenCalled()
  })
})

describe("pollTenantInbox — secrets at rest", () => {
  it("unseals imapPass before handing it to imapflow", async () => {
    const KEY = Buffer.alloc(32, 5).toString("base64")
    process.env.WABA_ENC_KEY = KEY
    const { sealSecret } = await import("@/lib/crypto/secret-box")
    await pollTenantInbox({ ...config, imapPass: sealSecret("real-pw", KEY) } as any, "t1")
    expect(imapCtorMock.mock.calls.at(-1)?.[0].auth.pass).toBe("real-pw")
  })

  it("TOLERANT READ — a legacy plaintext imapPass still connects", async () => {
    await pollTenantInbox(config as any, "t1")
    expect(imapCtorMock.mock.calls.at(-1)?.[0].auth.pass).toBe("pw")
  })
})

describe("testImapLogin", () => {
  it("opens, NOOPs, checks INBOX, logs out and records the result", async () => {
    emailConfigFindUniqueMock.mockResolvedValue(config)
    const r = await testImapLogin("t1")
    expect(r.ok).toBe(true)
    expect(noopMock).toHaveBeenCalled()
    expect(statusMock).toHaveBeenCalledWith("INBOX", { messages: true })
    expect(logoutMock).toHaveBeenCalled()
    expect(emailConfigUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastImapTestOk: true }) }),
    )
  })

  it("reports the failure and NEVER echoes the credential", async () => {
    emailConfigFindUniqueMock.mockResolvedValue({ ...config, imapPass: "sup3rs3cret" })
    connectMock.mockRejectedValue(new Error("Invalid credentials for sup3rs3cret"))
    const r = await testImapLogin("t1")
    expect(r.ok).toBe(false)
    expect(r.message).not.toContain("sup3rs3cret")
    expect(emailConfigUpdateMock).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ lastImapTestOk: false }) }),
    )
  })

  it("refuses when there is no config", async () => {
    emailConfigFindUniqueMock.mockResolvedValue(null)
    expect((await testImapLogin("t1")).ok).toBe(false)
  })

  it("refuses an unlisted host in restricted mode without connecting", async () => {
    delete process.env.EMAIL_DELIVERY_MODE
    process.env.EMAIL_INBOUND_ALLOWED_HOSTS = "imap.other.test"
    emailConfigFindUniqueMock.mockResolvedValue(config)
    const r = await testImapLogin("t1")
    expect(r.ok).toBe(false)
    expect(connectMock).not.toHaveBeenCalled()
  })

  it("still logs out when status() rejects after a successful connect", async () => {
    emailConfigFindUniqueMock.mockResolvedValue(config)
    statusMock.mockRejectedValue(new Error("mailbox unavailable"))
    const r = await testImapLogin("t1")
    expect(r.ok).toBe(false)
    expect(connectMock).toHaveBeenCalled()
    expect(logoutMock).toHaveBeenCalled()
  })

  it("a sealed imapPass with no WABA_ENC_KEY fails without connecting or leaking ciphertext", async () => {
    const KEY = Buffer.alloc(32, 7).toString("base64")
    const { sealSecret } = await import("@/lib/crypto/secret-box")
    const ciphertext = sealSecret("real-pw", KEY)
    emailConfigFindUniqueMock.mockResolvedValue({ ...config, imapPass: ciphertext })
    // WABA_ENC_KEY intentionally left unset.
    const r = await testImapLogin("t1")
    expect(r.ok).toBe(false)
    expect(r.message).not.toContain(ciphertext)
    expect(connectMock).not.toHaveBeenCalled()
  })
})
