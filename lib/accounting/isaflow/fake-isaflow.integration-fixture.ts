/**
 * A fake IsaFlow MCP server (node:http, port 0) for the integration tests and
 * the local browser run (scripts/fake-isaflow.ts). It follows the contract in
 * ./contract.ts: Bearer `pat_` tokens bound to one company with scopes, the
 * registry's order (scope → company assertion → idempotency key → replay →
 * handler), replay of a stored result for the same key and canonical args, a
 * refusal for the same key with other args, and refusals that free the key.
 * contract.test.ts pins its replies to the contract.
 *
 * Knobs: failNext() fails the next call of a tool; commitThenDrop() lets the next
 * create_draft_journal commit and then destroys the socket (an unknown
 * outcome); deleteDraft() removes a draft as a person in IsaFlow would (the
 * key's stored result stays, as it does in IsaFlow); calls[] records every call.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import { randomUUID } from "node:crypto"
import { RPC_CODES, SCOPES, TEXTS, TOOLS, type GlAccountRow, type JournalListEntry } from "./contract"

export type FailKind = "500" | "401" | "refuse" | "flows" | "disabled" | "rate"

export interface FakeCall {
  tool: string
  args: Record<string, unknown>
  rawBody: string
  outcome: "ok" | "refused" | "replayed" | "created" | "dropped" | "failed"
}

export interface FakeIsaFlowOptions {
  tokens?: Record<string, string[]>
  companyName?: string
  accounts?: Array<{ code: string; name?: string; active?: boolean }>
}

type Draft = JournalListEntry & { createdAt: number }
type Result = { content: Array<{ type: "text"; text: string }>; isError?: boolean }

const ok = (data: unknown): Result => ({ content: [{ type: "text", text: JSON.stringify(data) }] })
const refuse = (text: string): Result => ({ content: [{ type: "text", text }], isError: true })
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const cents = (v: unknown) => (v === undefined || v === null ? 0 : typeof v === "number" && Number.isFinite(v) ? Math.round(v * 100) : NaN)

/** IsaFlow hashes canonical (key-sorted) args (src/lib/mcp/audit.ts:39-46). */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (value && typeof value === "object") {
    const o = value as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`
  }
  return JSON.stringify(value)
}

export class FakeIsaFlow {
  readonly companyId = randomUUID()
  readonly companyName: string
  readonly tokens: Map<string, string[]>
  readonly accounts: GlAccountRow[]
  readonly calls: FakeCall[] = []
  private drafts: Draft[] = []
  private keys = new Map<string, { hash: string; result: Result }>()
  private failures: Array<{ kind: FailKind; tool: string }> = []
  private dropNextCreate = false
  private server: Server | null = null
  url = ""

  constructor(options: FakeIsaFlowOptions = {}) {
    this.companyName = options.companyName ?? "Fake IsaFlow Co"
    this.tokens = new Map(Object.entries(options.tokens ?? { pat_fake_isaflow: [SCOPES.WRITE_JOURNALS, SCOPES.READ_REPORTS] }))
    this.accounts = (options.accounts ?? []).map((a) => ({
      id: randomUUID(), account_code: a.code, account_name: a.name ?? `Account ${a.code}`, account_type: "asset",
      account_subtype: null, is_active: a.active ?? true, parent_account_id: null,
    }))
  }

  /** Fails the next call of `tool` (default create_draft_journal). */
  failNext(kind: FailKind, tool: string = TOOLS.CREATE_DRAFT_JOURNAL): void { this.failures.push({ kind, tool }) }
  commitThenDrop(): void { this.dropNextCreate = true }
  deleteDraft(id: string): void { this.drafts = this.drafts.filter((d) => d.id !== id) }
  listDrafts(): JournalListEntry[] { return this.drafts.map(({ createdAt: _c, ...d }) => d) }
  created(): number { return this.calls.filter((c) => c.outcome === "created" || c.outcome === "dropped").length }

  async start(port = 0, host = "127.0.0.1"): Promise<string> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server!.listen(port, host, resolve))
    this.url = `http://${host}:${(this.server.address() as AddressInfo).port}`
    return this.url
  }

  async stop(): Promise<void> {
    const server = this.server
    if (!server) return
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const rawBody = Buffer.concat(chunks).toString("utf8")
    const send = (status: number, body: unknown): void => { res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(body)) }
    if (req.method !== "POST" || req.url !== "/api/mcp") return send(404, { error: "not found" })
    const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "")?.[1] ?? ""
    const scopes = this.tokens.get(token)
    if (!/^(pat|oat)_/.test(token) || !scopes) return send(401, { success: false, error: { code: "INVALID_TOKEN", message: "Invalid, revoked, or expired token" } })
    let rpc: { id?: number | string; method?: string; params?: { name?: string; arguments?: Record<string, unknown> } }
    try {
      rpc = JSON.parse(rawBody) as typeof rpc
    } catch {
      return send(400, { jsonrpc: "2.0", id: null, error: { code: RPC_CODES.PARSE_ERROR, message: "Parse error — invalid JSON" } })
    }
    const id = rpc.id ?? null
    if (rpc.method !== "tools/call") return send(200, { jsonrpc: "2.0", id, error: { code: RPC_CODES.METHOD_NOT_FOUND, message: `method not found: ${rpc.method}` } })
    const tool = String(rpc.params?.name ?? "")
    const args = rpc.params?.arguments ?? {}
    const record = (outcome: FakeCall["outcome"]) => this.calls.push({ tool, args, rawBody, outcome })
    const at = this.failures.findIndex((f) => f.tool === tool)
    const failure = at >= 0 ? this.failures.splice(at, 1)[0].kind : undefined
    if (failure === "500") { record("failed"); return send(500, { success: false }) }
    if (failure === "401") { record("failed"); return send(401, { success: false, error: { code: "INVALID_TOKEN", message: "Invalid, revoked, or expired token" } }) }
    if (failure === "disabled") { record("failed"); return send(200, { jsonrpc: "2.0", id, error: { code: RPC_CODES.NOT_ENABLED, message: TEXTS.notEnabled } }) }
    if (failure === "rate") { record("failed"); return send(200, { jsonrpc: "2.0", id, error: { code: RPC_CODES.SERVER_ERROR, message: TEXTS.rateLimited } }) }
    const { result, outcome } = this.call(tool, args, scopes, failure)
    if (outcome === "created" && this.dropNextCreate) {
      this.dropNextCreate = false
      record("dropped")
      res.socket?.destroy()
      return
    }
    record(outcome)
    send(200, { jsonrpc: "2.0", id, result })
  }

  /** registry.ts:94-200, in its order. */
  private call(tool: string, args: Record<string, unknown>, scopes: string[], failure: FailKind | undefined): { result: Result; outcome: FakeCall["outcome"] } {
    const scope = { [TOOLS.LIST_COMPANIES]: null, company_profile: null, [TOOLS.LIST_GL_ACCOUNTS]: SCOPES.READ_REPORTS, [TOOLS.LIST_JOURNALS]: SCOPES.READ_REPORTS, [TOOLS.CREATE_DRAFT_JOURNAL]: SCOPES.WRITE_JOURNALS }[tool]
    if (scope === undefined) return { result: refuse(`Unknown tool: ${tool}`), outcome: "refused" }
    if (scope && !scopes.includes(scope)) return { result: refuse(TEXTS.insufficientScope(scope)), outcome: "refused" }
    if (tool !== TOOLS.CREATE_DRAFT_JOURNAL) return { result: this.read(tool, args), outcome: "ok" }
    if (args.company_id !== undefined && args.company_id !== this.companyId) {
      return { result: refuse(`company_id does not match this token's company. You asserted ${String(args.company_id)}; this token is bound to ${this.companyId}. Nothing was written. Re-check with list_companies before retrying.`), outcome: "refused" }
    }
    const key = typeof args.idempotency_key === "string" ? args.idempotency_key.trim() : ""
    if (!key) return { result: refuse(TEXTS.keyRequired), outcome: "refused" }
    const hash = canonical(args)
    const stored = this.keys.get(key)
    if (stored) return stored.hash === hash ? { result: stored.result, outcome: "replayed" } : { result: refuse(TEXTS.keyConflict), outcome: "refused" }
    if (failure === "flows") return { result: refuse(`Insufficient Flows: ${tool} costs 1 and the wallet holds 0. Top up to continue.`), outcome: "refused" }
    if (failure === "refuse") return { result: refuse("The operation failed. Please try again or contact support."), outcome: "refused" }
    const result = this.createDraft(args)
    if (result.isError) return { result, outcome: "refused" }
    this.keys.set(key, { hash, result })
    return { result, outcome: "created" }
  }

  /** writeJournals.ts:108-176 and doubleEntry.ts:18-147: ownership, one side per line, balanced. */
  private createDraft(args: Record<string, unknown>): Result {
    const date = typeof args.date === "string" ? args.date : ""
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return refuse("date is required (YYYY-MM-DD)")
    const raw = args.lines
    if (!Array.isArray(raw) || raw.length === 0) return refuse("lines must be a non-empty array of {account_id, debit, credit}")
    const lines = raw.map((l) => l as Record<string, unknown>)
    if (lines.some((l) => typeof l.account_id !== "string" || !UUID.test(l.account_id))) return refuse("invalid lines[].account_id")
    if (lines.some((l) => !this.accounts.some((a) => a.id === l.account_id))) return refuse(TEXTS.accountsNotOwned)
    const legs = lines.map((l) => ({ d: cents(l.debit), c: cents(l.credit) }))
    if (legs.length < 2 || legs.some(({ d, c }) => !(d >= 0 && c >= 0) || (d > 0) === (c > 0))) return refuse("Invalid journal entry: each line needs a debit or a credit")
    const dr = legs.reduce((s, l) => s + l.d, 0), cr = legs.reduce((s, l) => s + l.c, 0)
    if (dr !== cr) return refuse(`Invalid journal entry: Entry is not balanced: total debit R${(dr / 100).toFixed(2)} != total credit R${(cr / 100).toFixed(2)}`)
    const draft: Draft = {
      id: randomUUID(), entryNumber: `JE-${date.slice(0, 4)}-${String(this.drafts.length + 1).padStart(5, "0")}`, entryDate: date,
      description: typeof args.memo === "string" && args.memo.trim() ? args.memo.trim() : null, source: "manual", status: "draft", amount: dr / 100,
      lines: lines.map((l, i) => {
        const account = this.accounts.find((a) => a.id === l.account_id)!
        return { accountId: account.id, accountCode: account.account_code, accountName: account.account_name, debit: legs[i].d / 100, credit: legs[i].c / 100, description: typeof l.description === "string" ? l.description : null }
      }),
      createdAt: Date.now() + this.drafts.length,
    }
    this.drafts.push(draft)
    const { createdAt: _c, lines: _l, amount: _a, ...entry } = draft
    return ok({ ...entry, createdBy: "fake-user", createdAt: new Date(draft.createdAt).toISOString(), updatedAt: new Date(draft.createdAt).toISOString() })
  }

  private read(tool: string, args: Record<string, unknown>): Result {
    const offset = typeof args.cursor === "string" ? Number(Buffer.from(args.cursor, "base64url").toString("utf8")) : 0
    if (!Number.isInteger(offset) || offset < 0) return refuse("invalid cursor")
    const limit = (max: number, fallback: number) => (typeof args.limit === "number" && args.limit > 0 ? Math.min(Math.floor(args.limit), max) : fallback)
    const page = <T>(rows: T[], size: number) => ({ rows: rows.slice(offset, offset + size), next: offset + size < rows.length ? Buffer.from(String(offset + size)).toString("base64url") : null })
    if (tool === TOOLS.LIST_COMPANIES) {
      return ok({ companies: [{ company_id: this.companyId, name: this.companyName, vat_number: "4000000000", base_currency: "ZAR", is_active_company: true }], total: 1, note: "This token is bound to this company only; it cannot be switched from a tool argument." })
    }
    if (tool === "company_profile") return ok({ name: this.companyName, vat_number: "4000000000", financial_year_start_month: 3, base_currency: "ZAR", currency_symbol: "R", vat_period: "bi-monthly" })
    if (tool === TOOLS.LIST_GL_ACCOUNTS) {
      const activeOnly = args.active_only === undefined ? true : args.active_only !== false
      const matched = this.accounts.filter((a) => !activeOnly || a.is_active).sort((a, b) => a.account_code.localeCompare(b.account_code) || a.id.localeCompare(b.id))
      const { rows, next } = page(matched, limit(500, 200))
      return ok({ accounts: rows, total: matched.length, next_cursor: next })
    }
    const matched = this.drafts
      .filter((d) => (!args.from_date || d.entryDate >= String(args.from_date)) && (!args.to_date || d.entryDate <= String(args.to_date)))
      .filter((d) => !args.status || d.status === args.status)
      .sort((a, b) => b.entryDate.localeCompare(a.entryDate) || b.createdAt - a.createdAt || b.id.localeCompare(a.id))
    const { rows, next } = page(matched, limit(100, 50))
    const listed = rows.map(({ createdAt: _c, lines, ...d }) => ({ ...d, postingAgent: "mcp:create_draft_journal:v1", reversed: false, reversalOfId: null, fiscalPeriodId: null, ...(args.include_lines === true ? { lines: [...(lines ?? [])].sort((x, y) => y.debit - x.debit || y.credit - x.credit) } : {}) }))
    // journalEntryListService.ts:130: lines by debit, then credit, descending.
    return ok({ journals: listed, next_cursor: next })
  }
}
