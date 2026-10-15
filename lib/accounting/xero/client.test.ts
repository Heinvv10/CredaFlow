import { createHash } from "node:crypto"
import { describe, expect, it, vi } from "vitest"
import {
  authorizeUrl, createManualJournal, createPkcePair, exchangeCode, refreshTokens, xeroFetch, XeroError,
  XERO_MANUAL_JOURNALS_URL, XERO_TOKEN_URL, type XeroAppConfig,
} from "./client"
import { summariseForXero } from "./push"

const config: XeroAppConfig = { clientId: "client-abc", clientSecret: null, redirectUri: "https://lender.example/api/integrations/xero/callback", scopes: "offline_access accounting.transactions" }
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } })
const NOW = new Date("2026-10-14T10:00:00Z")

describe("Xero OAuth (PKCE)", () => {
  it("sends an S256 challenge of the verifier and the state", () => {
    const { verifier, challenge } = createPkcePair()
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"))
    const url = new URL(authorizeUrl(config, "state-1", challenge))
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      response_type: "code", client_id: "client-abc", state: "state-1", code_challenge: challenge, code_challenge_method: "S256",
      scope: "offline_access accounting.transactions",
    })
  })

  it("exchanges the code with the verifier, as a public client without a secret", async () => {
    const fetch = vi.fn(async () => json(200, { access_token: "at-1", refresh_token: "rt-1", expires_in: 1800 }))
    const tokens = await exchangeCode(config, { code: "code-1", verifier: "ver-1" }, { fetch }, NOW)
    expect(tokens).toEqual({ accessToken: "at-1", refreshToken: "rt-1", expiresAt: new Date("2026-10-14T10:30:00Z") })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(XERO_TOKEN_URL)
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "authorization_code", code: "code-1", redirect_uri: config.redirectUri, code_verifier: "ver-1", client_id: "client-abc",
    })
  })

  it("refreshes with the rotating refresh token and keeps the new one", async () => {
    const fetch = vi.fn(async () => json(200, { access_token: "at-2", refresh_token: "rt-2", expires_in: 1800 }))
    const tokens = await refreshTokens({ ...config, clientSecret: "s3cret" }, "rt-1", { fetch }, NOW)
    expect(tokens.refreshToken).toBe("rt-2")
    const [, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({ grant_type: "refresh_token", refresh_token: "rt-1" })
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from("client-abc:s3cret").toString("base64")}`)
  })

  it("refuses an invalid_grant without echoing the response body", async () => {
    const fetch = vi.fn(async () => json(400, { error: "invalid_grant", detail: "rt-secret-value" }))
    const error = await refreshTokens(config, "rt-1", { fetch }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(XeroError)
    expect((error as XeroError).kind).toBe("auth")
    expect((error as XeroError).message).not.toContain("rt-secret-value")
  })
})

describe("Xero rate limits", () => {
  it("waits Retry-After on a 429 and retries the same request", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(json(429, {}, { "retry-after": "7" }))
      .mockResolvedValueOnce(json(429, {}, {}))
      .mockResolvedValueOnce(json(200, { ok: true }))
    const sleep = vi.fn(async () => undefined)
    const res = await xeroFetch("https://api.xero.com/x", { method: "GET" }, { fetch, sleep })
    expect(res.status).toBe(200)
    expect(sleep.mock.calls).toEqual([[7000], [2000]])
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it("gives up after the retry budget as a DEFINITE failure (nothing was processed)", async () => {
    const fetch = vi.fn(async () => json(429, {}, { "retry-after": "1" }))
    const error = await xeroFetch("https://api.xero.com/x", {}, { fetch, sleep: async () => undefined, maxRetries: 2 }).catch((e: unknown) => e)
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(error).toMatchObject({ kind: "definite", status: 429 })
  })

  it("does not retry a network failure: its outcome is unknown", async () => {
    const fetch = vi.fn(async () => { throw new TypeError("fetch failed") })
    const error = await xeroFetch("https://api.xero.com/x", {}, { fetch }).catch((e: unknown) => e)
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(error).toMatchObject({ kind: "unknown" })
  })
})

describe("Xero manual journals", () => {
  const journal = summariseForXero([
    { lineNo: 1, postingDate: "2026-09-10", accountCode: "1000", taxCode: null, debitCents: 50_000, creditCents: 0, reference: "LN-1", description: "Receipt", eventKey: "payment:p1" },
    { lineNo: 2, postingDate: "2026-09-10", accountCode: "1100", taxCode: null, debitCents: 0, creditCents: 50_000, reference: "LN-1", description: "Receipt", eventKey: "payment:p1" },
    { lineNo: 3, postingDate: "2026-09-12", accountCode: "1100", taxCode: null, debitCents: 16_900, creditCents: 0, reference: "LN-1", description: "Due", eventKey: "i1" },
    { lineNo: 4, postingDate: "2026-09-12", accountCode: "4000", taxCode: null, debitCents: 0, creditCents: 16_900, reference: "LN-1", description: "Due", eventKey: "i1" },
  ], "CredaFlow journals September 2026", "2026-09-30")

  it("summarises per account, debits positive and credits negative, balanced, as a DRAFT", () => {
    expect(journal.JournalLines.map((l) => [l.AccountCode, l.LineAmount])).toEqual([["1000", 500], ["1100", -331], ["4000", -169]])
    expect(journal.JournalLines.reduce((s, l) => s + l.LineAmount, 0)).toBeCloseTo(0, 10)
    expect(journal).toMatchObject({ Status: "DRAFT", Date: "2026-09-30", LineAmountTypes: "NoTax" })
  })

  it("sends tax-inclusive when every account carries a tax code, and refuses a partly taxed journal", () => {
    const base = { postingDate: "2026-09-10", reference: "LN-1", description: "d", eventKey: "e" }
    const taxed = summariseForXero([
      { ...base, lineNo: 1, accountCode: "1090", taxCode: "NONE", debitCents: 115, creditCents: 0 },
      { ...base, lineNo: 2, accountCode: "4010", taxCode: "OUTPUT", debitCents: 0, creditCents: 115 },
    ], "n", "2026-09-30")
    expect(taxed.LineAmountTypes).toBe("Inclusive")
    expect(taxed.JournalLines.map((l) => l.TaxType)).toEqual(["NONE", "OUTPUT"])
    expect(() => summariseForXero([
      { ...base, lineNo: 1, accountCode: "1090", taxCode: null, debitCents: 115, creditCents: 0 },
      { ...base, lineNo: 2, accountCode: "4010", taxCode: "OUTPUT", debitCents: 0, creditCents: 115 },
    ], "n", "2026-09-30")).toThrow(/every account in the mapping, or on none/)
  })

  it("sends the organisation and an idempotency key, and returns the journal id", async () => {
    const fetch = vi.fn(async () => json(200, { ManualJournals: [{ ManualJournalID: "mj-1" }] }))
    const out = await createManualJournal({ accessToken: "at", xeroTenantId: "org-1", journal, idempotencyKey: "credaflow-b1-1" }, { fetch })
    expect(out).toEqual({ manualJournalId: "mj-1" })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(XERO_MANUAL_JOURNALS_URL)
    expect(init.method).toBe("PUT")
    expect(init.headers).toMatchObject({ "xero-tenant-id": "org-1", "idempotency-key": "credaflow-b1-1", authorization: "Bearer at" })
    expect(JSON.parse(String(init.body))).toEqual({ ManualJournals: [journal] })
  })

  it("classifies a validation refusal as definite and a 5xx as unknown", async () => {
    const refused = await createManualJournal({ accessToken: "at", xeroTenantId: "o", journal, idempotencyKey: "k" }, { fetch: async () => json(400, { Message: "Account code 9999 is not valid" }) }).catch((e: unknown) => e)
    expect(refused).toMatchObject({ kind: "definite", status: 400 })
    const unknown = await createManualJournal({ accessToken: "at", xeroTenantId: "o", journal, idempotencyKey: "k" }, { fetch: async () => json(503, {}) }).catch((e: unknown) => e)
    expect(unknown).toMatchObject({ kind: "unknown", status: 503 })
  })
})
