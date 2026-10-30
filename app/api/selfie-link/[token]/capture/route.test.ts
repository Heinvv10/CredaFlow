import { describe, expect, it, vi, beforeEach } from "vitest"

// vi.mock factories are hoisted above module scope, so these must be too.
const { resolveSelfieLinkToken, captureSelfie, update, updateMany, checkRateLimit } = vi.hoisted(() => ({
  resolveSelfieLinkToken: vi.fn(),
  captureSelfie: vi.fn(),
  update: vi.fn(),
  updateMany: vi.fn(),
  checkRateLimit: vi.fn(),
}))

vi.mock("@/lib/kyc/selfie-link-token.server", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/kyc/selfie-link-token.server")>()),
  resolveSelfieLinkToken,
}))
vi.mock("@/lib/kyc/selfie-capture.server", () => ({ captureSelfie }))
vi.mock("@/lib/prisma", () => ({ prisma: { selfieCaptureToken: { update, updateMany } } }))
const caller = vi.hoisted(() => ({ ip: "203.0.113.9" }))
vi.mock("@/lib/rate-limit", () => ({
  checkRateLimit,
  callerIp: () => caller.ip,
}))

const portal = vi.hoisted(() => ({ enabled: true }))
vi.mock("@/lib/portal/portal-policy", async (orig) => ({
  ...(await orig<typeof import("@/lib/portal/portal-policy")>()),
  portalOffRefusal: async () => {
    const { portalUnavailableResponse } = await orig<typeof import("@/lib/portal/portal-policy")>()
    return portal.enabled ? null : portalUnavailableResponse()
  },
}))

import { POST } from "./route"

function request(): Request {
  const fd = new FormData()
  fd.append("image", new File([new Uint8Array([1, 2, 3])], "s.jpg", { type: "image/jpeg" }))
  return new Request("http://x/api/selfie-link/abc/capture", { method: "POST", body: fd })
}

const LIVE_LINK = {
  ok: true,
  link: {
    tokenId: "tok1",
    tenantId: "t1",
    applicationId: "app1",
    clientId: "c1",
    clientFirstName: "Thabo",
  },
}

beforeEach(() => {
  // mockReset, not just clearAllMocks: clearAllMocks drops recorded calls but
  // KEEPS implementations, so a mockRejectedValue set in one test leaks into
  // every later one and makes the suite order-dependent.
  vi.clearAllMocks()
  caller.ip = "203.0.113.9"
  checkRateLimit.mockReset()
  update.mockReset()
  updateMany.mockReset()
  resolveSelfieLinkToken.mockReset()
  captureSelfie.mockReset()
  checkRateLimit.mockReturnValue({ allowed: true })
  update.mockResolvedValue({})
  updateMany.mockResolvedValue({ count: 1 })
})

describe("POST /api/selfie-link/[token]/capture — lender portal switched off", () => {
  it("refuses a live link with the portal-unavailable 404 and captures nothing", async () => {
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    portal.enabled = false
    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })
    portal.enabled = true
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual(expect.objectContaining({ portal: "disabled" }))
    expect(captureSelfie).not.toHaveBeenCalled()
    expect(updateMany).not.toHaveBeenCalled()
  })
})

describe("POST /api/selfie-link/[token]/capture", () => {
  it("refuses an expired token with 410 and never touches the capture pipeline", async () => {
    resolveSelfieLinkToken.mockResolvedValue({ ok: false, reason: "expired" })

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({
      error: "This link has expired. Ask your consultant to send a new one.",
    })
    expect(captureSelfie).not.toHaveBeenCalled()
  })

  it("refuses a malformed token with 400", async () => {
    resolveSelfieLinkToken.mockResolvedValue({ ok: false, reason: "malformed" })

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(400)
    expect(captureSelfie).not.toHaveBeenCalled()
  })

  it("refuses an unknown token with 404", async () => {
    resolveSelfieLinkToken.mockResolvedValue({ ok: false, reason: "unknown" })

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(404)
    expect(captureSelfie).not.toHaveBeenCalled()
  })

  it("refuses a used token with 410 rather than capturing a second time", async () => {
    resolveSelfieLinkToken.mockResolvedValue({ ok: false, reason: "used" })

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(410)
    expect(captureSelfie).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it("refuses a superseded token, so only the newest link works", async () => {
    resolveSelfieLinkToken.mockResolvedValue({ ok: false, reason: "invalidated" })

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(410)
    expect(await res.json()).toEqual({
      error: "A newer link was sent. Please use the most recent message.",
    })
  })

  it("refuses once the application has left a capturable status, with 409", async () => {
    resolveSelfieLinkToken.mockResolvedValue({ ok: false, reason: "application_changed" })

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(409)
    expect(captureSelfie).not.toHaveBeenCalled()
  })

  it("buckets a well-formed token by its DIGEST, never by the secret itself", async () => {
    // callerIp() returns the literal "unknown" unless TRUSTED_PROXY is set,
    // and it is set nowhere — so an IP-only bucket is one global bucket that
    // real consumers would 429 each other out of.
    const secret = "s".repeat(43)
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockResolvedValue({ ok: true, documentId: "doc1", document: {} })

    await POST(request(), { params: Promise.resolve({ token: secret }) })

    const keys = checkRateLimit.mock.calls.map((c) => String(c[0]))
    expect(keys.some((k) => k.startsWith("selfie-link:capture:tok:"))).toBe(true)
    expect(keys.join("|")).not.toContain(secret)
  })

  // PR #259: the address gate first, so a caller-chosen token key is never written for an address already over its limit.
  it("charges the address bucket before any token key, and stops there when the address is over its limit", async () => {
    checkRateLimit.mockImplementation((key: string) => (String(key).startsWith("selfie-link:capture:ip:") ? { allowed: false } : { allowed: true }))
    const res = await POST(request(), { params: Promise.resolve({ token: "s".repeat(43) }) })
    expect(res.status).toBe(429)
    expect(checkRateLimit.mock.calls.map((c) => String(c[0]))).toEqual(["selfie-link:capture:ip:203.0.113.9"])
    expect(resolveSelfieLinkToken).not.toHaveBeenCalled()
  })

  it("charges the address bucket first for an address that passes, then the token's", async () => {
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockResolvedValue({ ok: true, documentId: "doc1", document: {} })
    await POST(request(), { params: Promise.resolve({ token: "s".repeat(43) }) })
    const keys = checkRateLimit.mock.calls.map((c) => String(c[0]))
    expect(keys[0]).toBe("selfie-link:capture:ip:203.0.113.9")
    expect(keys[1]).toMatch(/^selfie-link:capture:tok:/)
  })

  it("buckets an IPv6 address by its /64 and skips the address bucket when no trusted proxy supplies one", async () => {
    caller.ip = "2001:db8:1:2:aaaa:bbbb:cccc:dddd"
    resolveSelfieLinkToken.mockResolvedValue({ ok: false, reason: "malformed" })
    await POST(request(), { params: Promise.resolve({ token: "not-a-secret" }) })
    expect(checkRateLimit.mock.calls[0]![0]).toBe("selfie-link:capture:ip:2001:db8:1:2::/64")
    checkRateLimit.mockClear()
    caller.ip = "unknown" // one shared bucket for everyone: never charged on every request
    await POST(request(), { params: Promise.resolve({ token: "s".repeat(43) }) })
    expect(checkRateLimit.mock.calls.map((c) => String(c[0])).some((k) => k.startsWith("selfie-link:capture:ip:"))).toBe(false)
  })

  it("charges the shared unresolved bucket for a malformed token", async () => {
    resolveSelfieLinkToken.mockResolvedValue({ ok: false, reason: "malformed" })

    await POST(request(), { params: Promise.resolve({ token: "not-a-secret" }) })

    const keys = checkRateLimit.mock.calls.map((c) => String(c[0]))
    // No per-token bucket for a malformed secret — a scanner would otherwise
    // mint a fresh unlimited key on every request.
    expect(keys.some((k) => k.startsWith("selfie-link:capture:tok:"))).toBe(false)
    expect(keys.some((k) => k.startsWith("selfie-link:capture:unresolved:"))).toBe(true)
  })

  it("NEVER charges the shared bucket for a token that resolved", async () => {
    // The shared bucket is one bucket for the whole deployment (callerIp
    // returns "unknown" with TRUSTED_PROXY unset). Charging it on success would
    // let an attacker flooding free malformed requests 429 real consumers.
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockResolvedValue({ ok: true, documentId: "doc1", document: {} })

    await POST(request(), { params: Promise.resolve({ token: "s".repeat(43) }) })

    const keys = checkRateLimit.mock.calls.map((c) => String(c[0]))
    expect(keys.some((k) => k.startsWith("selfie-link:capture:unresolved:"))).toBe(false)
  })

  it("a valid capture is not refused even when the shared bucket is exhausted", async () => {
    // The whole point of charging only failures: an attacker who has filled the
    // shared bucket must not be able to block a consumer holding a real link.
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockResolvedValue({ ok: true, documentId: "doc1", document: {} })
    checkRateLimit.mockImplementation((key: string) =>
      String(key).includes(":unresolved:") ? { allowed: false } : { allowed: true },
    )

    const res = await POST(request(), { params: Promise.resolve({ token: "s".repeat(43) }) })

    expect(res.status).toBe(200)
    expect(captureSelfie).toHaveBeenCalled()
  })

  it("releases the claim and returns a structured 500 when capture throws", async () => {
    // The claim leaves the row in a middle state that only a release or a bind
    // resolves. Nothing anywhere reclaims a stranded row — resolve checks
    // usedAt before expiresAt, so it would report "used" forever.
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockRejectedValue(new Error("pgbouncer failover"))

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to upload selfie" })
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "tok1", tenantId: "t1", documentId: null },
      data: { usedAt: null },
    })
  })

  it("does not throw out of the handler when even the release fails", async () => {
    // Worst case: the token IS stranded, but the consumer still gets a
    // structured error rather than an unhandled rejection.
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockRejectedValue(new Error("pgbouncer failover"))
    updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockRejectedValueOnce(new Error("still down"))

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Failed to upload selfie" })
  })

  it("still returns success when binding the document to the token fails", async () => {
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockResolvedValue({ ok: true, documentId: "doc1", document: {} })
    update.mockRejectedValue(new Error("db hiccup"))

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    // The photo was accepted and the face match is running; telling the
    // consumer it failed would be a lie.
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })

  it("refuses a well-formed token over its per-token limit BEFORE resolving it", async () => {
    // The per-token bucket still gates pre-resolution: one link must not be
    // able to drive unlimited database lookups or VLM face matches.
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    checkRateLimit.mockImplementation((key: string) =>
      String(key).includes(":tok:") ? { allowed: false } : { allowed: true },
    )

    const res = await POST(request(), { params: Promise.resolve({ token: "s".repeat(43) }) })

    expect(res.status).toBe(429)
    expect(resolveSelfieLinkToken).not.toHaveBeenCalled()
    expect(captureSelfie).not.toHaveBeenCalled()
  })

  it("captures against the token's client, ignoring any client in the body", async () => {
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockResolvedValue({ ok: true, documentId: "doc1", document: { id: "doc1" } })

    const fd = new FormData()
    fd.append("image", new File([new Uint8Array([1, 2, 3])], "s.jpg", { type: "image/jpeg" }))
    // A caller trying to aim the capture at someone else's record.
    fd.append("clientId", "SOMEONE-ELSE")
    fd.append("tenantId", "OTHER-TENANT")
    const req = new Request("http://x/api/selfie-link/abc/capture", { method: "POST", body: fd })

    const res = await POST(req, { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(200)
    expect(captureSelfie).toHaveBeenCalledWith({
      tenantId: "t1",
      clientId: "c1",
      image: expect.anything(),
      uploader: { type: "client", clientId: "c1", email: null },
    })
    const passed = JSON.stringify(captureSelfie.mock.calls[0][0])
    expect(passed).not.toContain("SOMEONE-ELSE")
    expect(passed).not.toContain("OTHER-TENANT")
  })

  it("claims the token with a compare-and-set BEFORE running the capture", async () => {
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockResolvedValue({ ok: true, documentId: "doc1", document: { id: "doc1" } })

    await POST(request(), { params: Promise.resolve({ token: "t" }) })

    // The claim must carry usedAt: null, or two concurrent requests both win.
    expect(updateMany).toHaveBeenNthCalledWith(1, {
      where: { id: "tok1", tenantId: "t1", usedAt: null, invalidatedAt: null },
      data: { usedAt: expect.any(Date) },
    })
    expect(updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(captureSelfie.mock.invocationCallOrder[0])
  })

  it("refuses when a concurrent request already claimed the token", async () => {
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    updateMany.mockResolvedValue({ count: 0 })

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(410)
    expect(captureSelfie).not.toHaveBeenCalled()
  })

  it("binds the burned token to the document it produced", async () => {
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockResolvedValue({ ok: true, documentId: "doc1", document: { id: "doc1" } })

    await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(update).toHaveBeenCalledWith({
      where: { id: "tok1" },
      data: { documentId: "doc1" },
    })
  })

  it("never returns the stored document body to an unauthenticated caller", async () => {
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockResolvedValue({
      ok: true,
      documentId: "doc1",
      document: { id: "doc1", clientId: "c1", contentSha256: "deadbeef" },
    })

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(await res.json()).toEqual({ ok: true })
  })

  it("does not burn the token when capture fails", async () => {
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    captureSelfie.mockResolvedValue({
      ok: false,
      status: 400,
      error: "Only JPEG/PNG images are accepted for selfies",
    })

    const res = await POST(request(), { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(400)
    // The claim is RELEASED so the consumer can retry the photo.
    expect(updateMany).toHaveBeenLastCalledWith({
      where: { id: "tok1", tenantId: "t1", documentId: null },
      data: { usedAt: null },
    })
    expect(update).not.toHaveBeenCalled()
  })

  it("returns a structured error when the multipart body cannot be parsed", async () => {
    // Same class as the sibling route's round-1 fix, missed here at the time.
    // Runs BEFORE the claim, so it can never strand a token.
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)
    const broken = new Request("http://x/api/selfie-link/abc/capture", {
      method: "POST",
      headers: { "content-type": "multipart/form-data; boundary=----nope" },
      body: "not actually multipart",
    })

    const res = await POST(broken, { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: "Failed to upload selfie" })
    expect(captureSelfie).not.toHaveBeenCalled()
    // Critically: the token was never claimed, so nothing needs releasing.
    expect(updateMany).not.toHaveBeenCalled()
  })

  it("rejects a request with no image before resolving anything expensive", async () => {
    resolveSelfieLinkToken.mockResolvedValue(LIVE_LINK)

    const req = new Request("http://x/api/selfie-link/abc/capture", {
      method: "POST",
      body: new FormData(),
    })
    const res = await POST(req, { params: Promise.resolve({ token: "t" }) })

    expect(res.status).toBe(400)
    expect(captureSelfie).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})
