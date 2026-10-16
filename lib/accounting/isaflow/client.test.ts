import { describe, expect, it, vi } from "vitest"
import { callTool, IsaFlowError, mcpTransport, type IsaFlowHttp } from "./client"

const BASE = "https://isaflow.example"
const target = { baseUrl: BASE, token: "pat_secret_token" }
const env = { NODE_ENV: "test", ISAFLOW_ALLOWED_ORIGINS: BASE } as unknown as NodeJS.ProcessEnv
const resolve = async () => [{ address: "93.184.216.34", family: 4 }]

const rpc = (result: unknown, status = 200) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result }), { status, headers: { "content-type": "application/json" } })
const ok = (data: unknown) => rpc({ content: [{ type: "text", text: JSON.stringify(data) }] })
const refused = (text: string) => rpc({ content: [{ type: "text", text }], isError: true })
const rpcError = (code: number, message: string) => new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code, message } }), { status: 200 })
const http = (fetch: unknown): IsaFlowHttp => ({ fetch: fetch as typeof globalThis.fetch, env, resolve })

async function kindOf(response: Response | Error): Promise<string> {
  const fetch = vi.fn(async () => {
    if (response instanceof Error) throw response
    return response
  })
  const error = await callTool(target, "list_companies", "{}", http(fetch)).catch((e: unknown) => e)
  expect(error).toBeInstanceOf(IsaFlowError)
  return (error as IsaFlowError).kind
}

describe("IsaFlow JSON-RPC client", () => {
  it("POSTs tools/call to /api/mcp with the Bearer token and the arguments text exactly as given", async () => {
    const fetch = vi.fn(async () => ok({ id: "j-1", entryNumber: "JE-2026-00001", status: "draft" }))
    const args = '{"date":"2026-09-30","memo":"m","lines":[],"idempotency_key":"k"}'
    await callTool(target, "create_draft_journal", args, http(fetch))
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${BASE}/api/mcp`)
    expect(init.method).toBe("POST")
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer pat_secret_token")
    expect(init.redirect).toBe("manual")
    expect(String(init.body)).toContain(`"arguments":${args}}`)
    expect(JSON.parse(String(init.body))).toMatchObject({ jsonrpc: "2.0", method: "tools/call", params: { name: "create_draft_journal" } })
  })

  it("says whether a failed request could have taken effect", async () => {
    expect(await kindOf(new TypeError("fetch failed"))).toBe("unknown")
    expect(await kindOf(new Response("", { status: 502 }))).toBe("unknown")
    expect(await kindOf(rpcError(-32603, "Internal error executing tool"))).toBe("unknown")
    expect(await kindOf(new Response("{not json", { status: 200 }))).toBe("unknown")
    expect(await kindOf(new Response("{}", { status: 401 }))).toBe("auth")
    expect(await kindOf(new Response("{}", { status: 403 }))).toBe("auth")
    expect(await kindOf(refused("Insufficient scope: this tool requires write:journals. Reconnect."))).toBe("auth")
    expect(await kindOf(new Response("{}", { status: 400 }))).toBe("definite")
    expect(await kindOf(new Response("{}", { status: 429 }))).toBe("definite")
    expect(await kindOf(new Response(null, { status: 302, headers: { location: "http://127.0.0.1/" } }))).toBe("definite")
    expect(await kindOf(rpcError(-32001, "MCP connector not enabled for this company"))).toBe("definite")
    expect(await kindOf(rpcError(-32000, "Rate limit exceeded. Slow down and retry."))).toBe("definite")
    expect(await kindOf(refused("Entry is not balanced"))).toBe("definite")
  })

  it("carries IsaFlow's refusal text, never the token", async () => {
    const fetch = vi.fn(async () => refused("One or more account_id values are not GL accounts in your company."))
    const error = (await callTool(target, "create_draft_journal", "{}", http(fetch)).catch((e: unknown) => e)) as IsaFlowError
    expect(error.message).toContain("not GL accounts in your company")
    expect(error.message).not.toContain("pat_secret_token")
  })

  it("refuses a base URL this deployment does not allow before any request (config)", async () => {
    const fetch = vi.fn()
    const error = (await callTool({ ...target, baseUrl: "https://elsewhere.example" }, "list_companies", "{}", http(fetch)).catch((e: unknown) => e)) as IsaFlowError
    expect(error.kind).toBe("config")
    const internal = { fetch: fetch as unknown as typeof globalThis.fetch, env, resolve: async () => [{ address: "10.0.0.5", family: 4 }] }
    expect(((await callTool(target, "list_companies", "{}", internal).catch((e: unknown) => e)) as IsaFlowError).kind).toBe("config")
    expect(fetch).not.toHaveBeenCalled()
  })

  it("dials only the address it checked: a name that re-points to a private address at dial time is refused (DNS rebinding)", async () => {
    const origin = "https://isaflow.invalid"
    const answers = [[{ address: "93.184.216.34", family: 4 }], [{ address: "10.0.0.5", family: 4 }]]
    const rebinding = vi.fn(async () => answers[Math.min(rebinding.mock.calls.length - 1, 1)])
    const allowed = { NODE_ENV: "test", ISAFLOW_ALLOWED_ORIGINS: origin } as unknown as NodeJS.ProcessEnv
    const error = (await callTool({ baseUrl: origin, token: "pat_x" }, "list_companies", "{}", { env: allowed, resolve: rebinding }).catch((e: unknown) => e)) as IsaFlowError
    expect(error).toBeInstanceOf(IsaFlowError)
    expect(error).toMatchObject({ kind: "config", message: expect.stringContaining("10.0.0.5") })
    // Once when the origin is checked, once inside the connection's own lookup.
    expect(rebinding).toHaveBeenCalledTimes(2)
  })

  it("follows list_gl_accounts' cursor, all accounts including inactive, every other argument unchanged", async () => {
    const account = (code: string, active = true) => ({ id: `id-${code}`, account_code: code, account_name: code, account_type: "asset", account_subtype: null, is_active: active, parent_account_id: null })
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok({ accounts: [account("1000")], total: 3, next_cursor: "c1" }))
      .mockResolvedValueOnce(ok({ accounts: [account("1100")], total: 3, next_cursor: "c2" }))
      .mockResolvedValueOnce(ok({ accounts: [account("4000", false)], total: 3, next_cursor: null }))
    const accounts = await mcpTransport(target, http(fetch)).listGlAccounts()
    expect(accounts.map((a) => [a.account_code, a.is_active])).toEqual([["1000", true], ["1100", true], ["4000", false]])
    const sent = fetch.mock.calls.map((c) => JSON.parse(String((c as unknown as [string, RequestInit])[1].body)).params.arguments)
    expect(sent).toEqual([
      { active_only: false, limit: 500 },
      { active_only: false, limit: 500, cursor: "c1" },
      { active_only: false, limit: 500, cursor: "c2" },
    ])
  })

  it("lists one day's draft journals with their lines, across pages", async () => {
    const journal = (id: string) => ({ id, entryNumber: id, entryDate: "2026-09-30", description: "m", source: "manual", status: "draft", amount: 10, lines: [] })
    const fetch = vi.fn()
      .mockResolvedValueOnce(ok({ journals: [journal("a")], next_cursor: "n1" }))
      .mockResolvedValueOnce(ok({ journals: [journal("b")], next_cursor: null }))
    const out = await mcpTransport(target, http(fetch)).listDraftJournals("2026-09-30")
    expect(out.map((j) => j.id)).toEqual(["a", "b"])
    const second = JSON.parse(String((fetch.mock.calls[1] as unknown as [string, RequestInit])[1].body)).params.arguments
    expect(second).toEqual({ from_date: "2026-09-30", to_date: "2026-09-30", status: "draft", include_lines: true, limit: 100, cursor: "n1" })
  })

  it("treats a reply in the wrong shape as an unknown outcome", async () => {
    const fetch = vi.fn(async () => ok({ nope: true }))
    const error = (await mcpTransport(target, http(fetch)).createDraftJournal("{}").catch((e: unknown) => e)) as IsaFlowError
    expect(error.kind).toBe("unknown")
  })
})
