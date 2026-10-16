/**
 * IsaFlow over its MCP endpoint (JSON-RPC 2.0 `tools/call`, Bearer PAT), the
 * only machine-to-machine way into IsaFlow today: its REST journal endpoint
 * takes a session cookie only and has no external reference (spec §1.2).
 * Everything above this file talks to an IsaFlowTransport, so a REST adapter
 * can replace mcpTransport once IsaFlow ships Bearer auth plus `external_ref`
 * there. Reply shapes and refusal texts: ./contract.ts.
 *
 * Errors say whether a request could have taken effect, as the Xero client's
 * do: a 4xx, a refusal (`isError`), a transport refusal (connector off, rate
 * limit) or a redirect is DEFINITE (IsaFlow ran nothing, and a refusal frees
 * the idempotency key); a network failure, a timeout, a 5xx, an internal RPC
 * error or an unreadable reply is UNKNOWN. 401/403 and a missing scope are
 * AUTH (the connection needs a new token); a base URL this deployment does
 * not allow is CONFIG, refused before anything is sent.
 */
import type { Resolver } from "@/lib/lender-api/webhooks/ssrf"
import { assertIsaFlowOrigin, IsaFlowUrlError } from "./base-url"
import {
  IsaFlowContractError, MCP_PATH, parseCompanies, parseCreatedJournal, parseGlAccountsPage, parseJournalsPage, RPC_CODES, TOOLS,
  type CreatedJournal, type GlAccountRow, type IsaFlowCompany, type JournalListEntry, type RpcResponse,
} from "./contract"

export interface IsaFlowHttp {
  fetch?: typeof fetch
  resolve?: Resolver
  env?: NodeJS.ProcessEnv
  /** One deadline per request (default 30 s). */
  timeoutMs?: number
}

export class IsaFlowError extends Error {
  constructor(readonly kind: "definite" | "unknown" | "auth" | "config", message: string, readonly status?: number) {
    super(message)
    this.name = "IsaFlowError"
  }
}

export interface IsaFlowTarget {
  baseUrl: string
  token: string
}

const MAX_PAGES = 50
let rpcId = 0

/** One tools/call. `argsJson` is embedded as given, so a stored request is resent byte for byte. Returns the parsed result text. */
export async function callTool(target: IsaFlowTarget, tool: string, argsJson: string, http: IsaFlowHttp = {}): Promise<unknown> {
  let origin: string
  try {
    origin = await assertIsaFlowOrigin(target.baseUrl, http.env ?? process.env, http.resolve)
  } catch (error) {
    if (error instanceof IsaFlowUrlError) throw new IsaFlowError("config", error.message)
    throw error
  }
  const body = `{"jsonrpc":"2.0","id":${++rpcId},"method":"tools/call","params":{"name":${JSON.stringify(tool)},"arguments":${argsJson}}}`
  let res: Response
  try {
    res = await (http.fetch ?? fetch)(`${origin}${MCP_PATH}`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json", accept: "application/json" },
      body,
      redirect: "manual",
      signal: AbortSignal.timeout(http.timeoutMs ?? 30_000),
    })
  } catch (error) {
    throw new IsaFlowError("unknown", `IsaFlow request failed: ${error instanceof Error ? error.message : "network error"}`)
  }
  if (res.status === 401 || res.status === 403) throw new IsaFlowError("auth", `IsaFlow refused the token (${res.status}); connect IsaFlow again with a valid token`, res.status)
  if (res.status >= 500) throw new IsaFlowError("unknown", `IsaFlow answered ${res.status}; the request may or may not have taken effect`, res.status)
  if (res.status !== 200) throw new IsaFlowError("definite", `IsaFlow refused the request (${res.status})`, res.status)
  const rpc = (await res.json().catch(() => null)) as RpcResponse | null
  if (rpc?.error) {
    const { code, message } = rpc.error
    if (code === RPC_CODES.INTERNAL_ERROR) throw new IsaFlowError("unknown", `IsaFlow failed while running ${tool}; it may or may not have taken effect`)
    const text = code === RPC_CODES.NOT_ENABLED ? "IsaFlow's MCP connector is not enabled for this company" : String(message).slice(0, 300)
    throw new IsaFlowError("definite", `IsaFlow refused ${tool}: ${text}`)
  }
  const text = rpc?.result?.content?.[0]?.text
  if (typeof text !== "string") throw new IsaFlowError("unknown", `IsaFlow's answer to ${tool} could not be read`)
  if (rpc!.result!.isError === true) {
    const kind = text.startsWith("Insufficient scope") ? "auth" : "definite"
    throw new IsaFlowError(kind, `IsaFlow refused ${tool}: ${text.slice(0, 500)}`)
  }
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new IsaFlowError("unknown", `IsaFlow's answer to ${tool} could not be read`)
  }
}

/** What the push needs from IsaFlow, whatever the wire. */
export interface IsaFlowTransport {
  /** The one company the token is bound to. */
  company(): Promise<IsaFlowCompany>
  /** The whole chart, inactive accounts included. */
  listGlAccounts(): Promise<GlAccountRow[]>
  /** `argsJson` is the stored request; it is sent unchanged. */
  createDraftJournal(argsJson: string): Promise<CreatedJournal>
  /** Every draft journal dated `date`, with its lines. */
  listDraftJournals(date: string): Promise<JournalListEntry[]>
}

function parsed<T>(parse: (data: unknown) => T, data: unknown): T {
  try {
    return parse(data)
  } catch (error) {
    if (error instanceof IsaFlowContractError) throw new IsaFlowError("unknown", error.message)
    throw error
  }
}

async function paged<T>(fetchPage: (cursor: string | null) => Promise<{ rows: T[]; next: string | null }>): Promise<T[]> {
  const out: T[] = []
  let cursor: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const { rows, next } = await fetchPage(cursor)
    out.push(...rows)
    if (next === null) return out
    cursor = next
  }
  throw new IsaFlowError("definite", `IsaFlow returned more than ${MAX_PAGES} pages`)
}

export function mcpTransport(target: IsaFlowTarget, http: IsaFlowHttp = {}): IsaFlowTransport {
  const call = (tool: string, args: Record<string, unknown>) => callTool(target, tool, JSON.stringify(args), http)
  return {
    company: async () => parsed(parseCompanies, await call(TOOLS.LIST_COMPANIES, {})),
    listGlAccounts: () => paged(async (cursor) => {
      const page = parsed(parseGlAccountsPage, await call(TOOLS.LIST_GL_ACCOUNTS, { active_only: false, limit: 500, ...(cursor ? { cursor } : {}) }))
      return { rows: page.accounts, next: page.next_cursor }
    }),
    createDraftJournal: async (argsJson) => parsed(parseCreatedJournal, await callTool(target, TOOLS.CREATE_DRAFT_JOURNAL, argsJson, http)),
    listDraftJournals: (date) => paged(async (cursor) => {
      const args = { from_date: date, to_date: date, status: "draft", include_lines: true, limit: 100, ...(cursor ? { cursor } : {}) }
      const page = parsed(parseJournalsPage, await call(TOOLS.LIST_JOURNALS, args))
      return { rows: page.journals, next: page.next_cursor }
    }),
  }
}
