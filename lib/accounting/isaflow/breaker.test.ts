/**
 * Breaker repros (no database): SSRF address forms, redirects, header-invalid
 * tokens, cent round trips. Each `it` is one finding or one pinned non-finding.
 */
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it, vi } from "vitest"
import { isBlockedAddress } from "@/lib/lender-api/webhooks/ssrf"
import { assertIsaFlowOrigin, isaflowOrigin } from "./base-url"
import { callTool, IsaFlowError } from "./client"
import { guardedPost } from "./dial"
import { buildDraftJournal, findPushedDraft, netByAccount, randsAmount } from "./journal"

const envFor = (list: string, NODE_ENV = "production") => ({ NODE_ENV, ISAFLOW_ALLOWED_ORIGINS: list }) as unknown as NodeJS.ProcessEnv
const publicDns = async () => [{ address: "93.184.216.34", family: 4 }]

describe("breaker 4: SSRF via baseUrl", () => {
  it("refuses every non-listed or malformed form before any DNS", () => {
    const env = envFor("https://app.isaflow.co.za")
    for (const raw of [
      "http://app.isaflow.co.za", "http://127.0.0.1:3000", "https://127.0.0.1", "https://10.0.0.5", "https://169.254.169.254",
      "https://[::1]", "https://[::ffff:127.0.0.1]", "https://[::ffff:7f00:1]", "https://2130706433", "https://0x7f.0.0.1", "https://0177.0.0.1",
      "https://app.isaflow.co.za@evil.example", "https://app.isaflow.co.za:8443", "https://app.isaflow.co.za./", "https://app.isaflow.co.za:80",
      "https://evil.example\\@app.isaflow.co.za", "https://app.isaflow.co.za%2F@evil.example", "https://app.isaflow.co.za/x", "https://app.isaflow.co.za/?a=b",
      "ftp://app.isaflow.co.za", "javascript:alert(1)", "https://xn--app-isaflow.co.za",
    ]) expect(() => isaflowOrigin(raw, env), raw).toThrow()
  })

  it("normalises an uppercase host to the listed origin (accepted, same origin)", () => {
    expect(isaflowOrigin("HTTPS://APP.ISAFLOW.CO.ZA", envFor("https://app.isaflow.co.za"))).toBe("https://app.isaflow.co.za")
  })

  it("plain http loopback only under test/development, never in production, never ::ffff: or a trailing dot", () => {
    expect(() => isaflowOrigin("http://127.0.0.1:9", envFor("http://127.0.0.1:9", "production"))).toThrow()
    expect(isaflowOrigin("http://127.0.0.1:9", envFor("http://127.0.0.1:9", "test"))).toBe("http://127.0.0.1:9")
    for (const raw of ["http://[::ffff:7f00:1]:9", "http://localhost.:9", "http://0:9", "http://0.0.0.0:9"]) {
      const listed = (() => { try { return new URL(raw).origin } catch { return raw } })()
      expect(() => isaflowOrigin(raw, envFor(listed, "test")), raw).toThrow()
    }
  })

  it("even if an operator lists a private/literal origin, the DNS check refuses it", async () => {
    for (const raw of ["https://127.0.0.1", "https://10.1.2.3", "https://169.254.169.254", "https://[::1]", "https://[::ffff:127.0.0.1]", "https://2130706433", "https://0x7f000001", "https://0177.0.0.1", "https://[::ffff:a00:1]", "https://[64:ff9b::7f00:1]", "https://[2002:7f00:1::]"]) {
      await expect(assertIsaFlowOrigin(raw, envFor(raw), publicDns), raw).rejects.toThrow(/not a public address/)
    }
  })

  it("isBlockedAddress covers non-canonical IPv6 spellings a resolver may return", () => {
    for (const a of ["0:0:0:0:0:ffff:7f00:1", "0:0:0:0:0:ffff:127.0.0.1", "::ffff:0:127.0.0.1", "::127.0.0.1", "0000:0000:0000:0000:0000:ffff:0a00:0001", "fe80::1%eth0", "::FFFF:10.0.0.1", "64:ff9b::a00:1", "0:0:0:0:0:0:0:1"]) {
      expect(isBlockedAddress(a), a).toBe(true)
    }
  })

  it("does not follow a redirect to an internal URL", async () => {
    const internal = vi.fn()
    const sink = createServer((_q, r) => { internal(); r.end("secret") })
    await new Promise<void>((ok) => sink.listen(0, "127.0.0.1", ok))
    const sinkUrl = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/`
    const hop = createServer((_q, r) => r.writeHead(302, { location: sinkUrl }).end())
    await new Promise<void>((ok) => hop.listen(0, "127.0.0.1", ok))
    const base = `http://127.0.0.1:${(hop.address() as AddressInfo).port}`
    const error = await callTool({ baseUrl: base, token: "pat_redirect_test" }, "list_companies", "{}", { env: envFor(base, "test") }).catch((e: unknown) => e)
    hop.close(); sink.close()
    expect(error).toBeInstanceOf(IsaFlowError)
    expect((error as IsaFlowError).kind).toBe("definite")
    expect(internal).not.toHaveBeenCalled()
  })
})

describe("breaker 3/robustness: a token with a character HTTP headers cannot carry", () => {
  // parseConnectInput accepts /^pat_[^\s]{8,500}$/, so "pat_12345678€" passes the shape check.
  it("rejects without leaving a timer that throws later (ReferenceError on `req` in dial.ts)", async () => {
    const uncaught: unknown[] = []
    const onUncaught = (e: unknown) => uncaught.push(e)
    const saved = process.listeners("uncaughtException")
    process.removeAllListeners("uncaughtException")
    process.on("uncaughtException", onUncaught)
    try {
      const sink = createServer((_q, r) => r.end("{}"))
      await new Promise<void>((ok) => sink.listen(0, "127.0.0.1", ok))
      const url = `http://127.0.0.1:${(sink.address() as AddressInfo).port}/api/mcp`
      const outcome = await guardedPost(url, { headers: { authorization: "Bearer pat_12345678€", "content-type": "application/json" }, body: "{}" }, { timeoutMs: 150 }).catch((e: unknown) => e)
      expect(outcome).toBeInstanceOf(Error)
      await new Promise((r) => setTimeout(r, 400))
      sink.close()
      expect(uncaught.map(String)).toEqual([])
    } finally {
      process.off("uncaughtException", onUncaught)
      for (const l of saved) process.on("uncaughtException", l as never)
    }
  })
})

describe("breaker: cents", () => {
  it("every cent amount survives rands -> JSON -> cents (read-back compares them)", () => {
    for (let c = 0; c <= 2_000_000; c++) {
      const back = Math.round(randsAmount(c) * 100)
      if (back !== c) throw new Error(`cents ${c} -> ${randsAmount(c)} -> ${back}`)
    }
    for (const c of [99_999_999_999_99, 123_456_789_012_345]) expect(Math.round(randsAmount(c) * 100)).toBe(c)
  })

  it("odd cents netting to zero are dropped, the rest balances; a month netting to nothing is refused", () => {
    const l = (accountCode: string, debitCents: number, creditCents: number) => ({ accountCode, debitCents, creditCents }) as never
    const net = netByAccount([l("1100", 3333, 0), l("1100", 0, 3333), l("4000", 0, 1), l("1000", 1, 0)])
    expect(net).toEqual([{ code: "1000", debitCents: 1, creditCents: 0 }, { code: "4000", debitCents: 0, creditCents: 1 }])
    expect(() => buildDraftJournal({ batchId: "b", label: "x", date: "2026-08-31", companyId: "c", lines: [], accountIds: new Map() })).toThrow(/nothing to push/)
    const ids = new Map([["1000", "a"], ["4000", "b"]])
    const { argsJson } = buildDraftJournal({ batchId: "b", label: "x", date: "2026-08-31", companyId: "c", lines: net, accountIds: ids })
    const entry = { id: "j", entryNumber: "JE-1", description: "x [credaflow:b]", lines: [{ accountId: "a", debit: 0.01, credit: 0 }, { accountId: "b", debit: 0, credit: 0.01 }] } as never
    expect(findPushedDraft([entry], argsJson).found).toBe(entry)
  })
})
