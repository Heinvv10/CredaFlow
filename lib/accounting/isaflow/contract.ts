/**
 * The IsaFlow MCP contract this client is built to: read from the IsaFlow
 * source (read only, /home/hein/Workspace/IsaFlow at e316da28b) and pinned
 * here with file:line references. The fake server
 * (fake-isaflow.integration-fixture.ts) answers in these shapes, and
 * contract.test.ts holds the two to each other: a change on either side shows
 * up as a red test, not as a push that silently misreads a reply.
 *
 * Transport (pages/api/mcp/index.ts):
 *  - POST /api/mcp, JSON-RPC 2.0, `tools/call` with `{ name, arguments }` (:119-138).
 *  - Bearer only: `pat_…` or `oat_…`; anything else, or an invalid token, is
 *    HTTP 401 (src/lib/auth/bearerPipeline.ts:96-123); not a member of the
 *    token's company is 403 (:164-170). The company is bound to the token.
 *  - The `mcp_connector` flag off is HTTP 200 with RPC error -32001 (:148-151,
 *    src/lib/mcp/transportRefusals.ts:26); the 120/min company limit is 200
 *    with -32000 (:174-176); the per-IP throttle is 429 (:268).
 *  - A tool result is `{ content: [{ type: "text", text }], isError? }` where
 *    `text` is JSON on success and a plain message on a refusal
 *    (src/lib/mcp/tools/toolHelpers.ts:9-17).
 *
 * Registry (src/lib/mcp/registry.ts):
 *  - scope checked before anything (:97-102); a write needs `idempotency_key` (:142-144);
 *  - the assert-only `company_id` on a write is refused when it differs from
 *    the token's company, before the key is touched (:127-130, src/lib/mcp/companyAssert.ts:45-72);
 *  - same key + same args (canonical hash) replays the stored result; same key
 *    + different args is refused (:146-165, src/lib/mcp/audit.ts:39-46,136-153);
 *  - a refusal (`isError`) frees the key (:187-199).
 */

export const MCP_PATH = "/api/mcp"

/** src/lib/mcp/jsonrpc.ts:8-16 */
export const RPC_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
  NOT_ENABLED: -32001,
} as const

export const SCOPES = { WRITE_JOURNALS: "write:journals", READ_REPORTS: "read:reports" } as const

export const TOOLS = {
  /** src/lib/mcp/tools/company.ts:47-69, any scope. company_profile (:10-29) carries no company id. */
  LIST_COMPANIES: "list_companies",
  /** src/lib/mcp/tools/reports.ts:122-200, scope read:reports, ordered by code, paged by next_cursor, max 500. */
  LIST_GL_ACCOUNTS: "list_gl_accounts",
  /** src/lib/mcp/tools/writeJournals.ts:67-178, scope write:journals, creates a DRAFT, never posts. */
  CREATE_DRAFT_JOURNAL: "create_draft_journal",
  /** src/lib/mcp/tools/journals.ts:16-71, scope read:reports, newest first, paged by next_cursor, max 100. */
  LIST_JOURNALS: "list_journals",
} as const

/** Refusal texts the client recognises (registry.ts:101, :143, :161, scopeRemediation.ts:51, writeJournals.ts:126). */
export const TEXTS = {
  insufficientScope: (scope: string) => `Insufficient scope: this tool requires ${scope}.`,
  keyRequired: "idempotency_key is required for write operations",
  keyConflict: "idempotency_key was already used for a different request. Use a fresh key.",
  accountsNotOwned: "One or more account_id values are not GL accounts in your company.",
  notEnabled: "MCP connector not enabled for this company",
  rateLimited: "Rate limit exceeded. Slow down and retry.",
} as const

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>
  isError?: boolean
}

export interface RpcResponse {
  jsonrpc: "2.0"
  id: string | number | null
  result?: ToolResult
  error?: { code: number; message: string; data?: unknown }
}

/** list_companies: always exactly one row (company.ts:58-68). */
export interface IsaFlowCompany {
  company_id: string
  name: string
  vat_number: string | null
}

/** reports.ts:112-120, the row list_gl_accounts returns. */
export interface GlAccountRow {
  id: string
  account_code: string
  account_name: string
  account_type: string
  account_subtype: string | null
  is_active: boolean
  parent_account_id: string | null
}

export interface GlAccountsPage { accounts: GlAccountRow[]; total: number; next_cursor: string | null }

/** src/modules/accounting/services/gl/journalEntryListService.ts:38-61. Amounts in rands. */
export interface JournalListLine { accountId: string; accountCode: string | null; accountName: string | null; debit: number; credit: number; description: string | null }
export interface JournalListEntry {
  id: string
  entryNumber: string
  entryDate: string
  description: string | null
  source: string
  status: string
  amount: number
  lines?: JournalListLine[]
}
export interface JournalsPage { journals: JournalListEntry[]; next_cursor: string | null }

/** The created entry (src/modules/accounting/types/gl.types.ts:209-230); only these fields are read. */
export interface CreatedJournal { id: string; entryNumber: string; status: string }

export class IsaFlowContractError extends Error {
  constructor(what: string) {
    super(`IsaFlow answered in an unexpected shape (${what})`)
    this.name = "IsaFlowContractError"
  }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v)
const str = (o: Obj, k: string, what: string): string => {
  if (typeof o[k] !== "string") throw new IsaFlowContractError(`${what}.${k}`)
  return o[k] as string
}
const optStr = (o: Obj, k: string): string | null => (typeof o[k] === "string" ? (o[k] as string) : null)
const num = (o: Obj, k: string, what: string): number => {
  if (typeof o[k] !== "number" || !Number.isFinite(o[k])) throw new IsaFlowContractError(`${what}.${k}`)
  return o[k] as number
}
const cursor = (o: Obj, what: string): string | null => {
  if (o.next_cursor === null || typeof o.next_cursor === "string") return o.next_cursor as string | null
  throw new IsaFlowContractError(`${what}.next_cursor`)
}

export function parseCompanies(data: unknown): IsaFlowCompany {
  if (!isObj(data) || !Array.isArray(data.companies) || data.companies.length !== 1 || !isObj(data.companies[0])) {
    throw new IsaFlowContractError("list_companies")
  }
  const c = data.companies[0]
  return { company_id: str(c, "company_id", "company"), name: str(c, "name", "company"), vat_number: optStr(c, "vat_number") }
}

export function parseGlAccountsPage(data: unknown): GlAccountsPage {
  if (!isObj(data) || !Array.isArray(data.accounts)) throw new IsaFlowContractError("list_gl_accounts")
  const accounts = data.accounts.map((a): GlAccountRow => {
    if (!isObj(a) || typeof a.is_active !== "boolean") throw new IsaFlowContractError("account")
    return {
      id: str(a, "id", "account"), account_code: str(a, "account_code", "account"), account_name: str(a, "account_name", "account"),
      account_type: str(a, "account_type", "account"), account_subtype: optStr(a, "account_subtype"), is_active: a.is_active,
      parent_account_id: optStr(a, "parent_account_id"),
    }
  })
  return { accounts, total: num(data, "total", "list_gl_accounts"), next_cursor: cursor(data, "list_gl_accounts") }
}

export function parseJournalsPage(data: unknown): JournalsPage {
  if (!isObj(data) || !Array.isArray(data.journals)) throw new IsaFlowContractError("list_journals")
  const journals = data.journals.map((j): JournalListEntry => {
    if (!isObj(j)) throw new IsaFlowContractError("journal")
    const lines = j.lines === undefined ? undefined : Array.isArray(j.lines) ? j.lines.map((l): JournalListLine => {
      if (!isObj(l)) throw new IsaFlowContractError("journal line")
      return {
        accountId: str(l, "accountId", "line"), accountCode: optStr(l, "accountCode"), accountName: optStr(l, "accountName"),
        debit: num(l, "debit", "line"), credit: num(l, "credit", "line"), description: optStr(l, "description"),
      }
    }) : (() => { throw new IsaFlowContractError("journal.lines") })()
    return {
      id: str(j, "id", "journal"), entryNumber: str(j, "entryNumber", "journal"), entryDate: str(j, "entryDate", "journal"),
      description: optStr(j, "description"), source: str(j, "source", "journal"), status: str(j, "status", "journal"),
      amount: num(j, "amount", "journal"), ...(lines ? { lines } : {}),
    }
  })
  return { journals, next_cursor: cursor(data, "list_journals") }
}

export function parseCreatedJournal(data: unknown): CreatedJournal {
  if (!isObj(data)) throw new IsaFlowContractError("create_draft_journal")
  return { id: str(data, "id", "journal"), entryNumber: str(data, "entryNumber", "journal"), status: str(data, "status", "journal") }
}
