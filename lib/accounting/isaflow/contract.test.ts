/**
 * Pins the fake IsaFlow to ./contract.ts: every reply the fake gives must
 * parse with the contract's parsers and carry the contract's refusal texts,
 * through the real client over a real socket. When IsaFlow changes, update
 * contract.ts (with its file:line), watch this go red, then fix the fake.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { callTool, IsaFlowError, mcpTransport, type IsaFlowTransport } from "./client"
import { RPC_CODES, SCOPES, TEXTS, parseGlAccountsPage, parseJournalsPage } from "./contract"
import { FakeIsaFlow } from "./fake-isaflow.integration-fixture"

const fake = new FakeIsaFlow({
  tokens: { pat_full: [SCOPES.WRITE_JOURNALS, SCOPES.READ_REPORTS], pat_read: [SCOPES.READ_REPORTS] },
  accounts: [...Array.from({ length: 1201 }, (_, i) => ({ code: String(10000 + i) })), { code: "99999", active: false }],
})
let isa: IsaFlowTransport

const failure = (p: Promise<unknown>) => p.then(() => { throw new Error("expected a refusal") }, (e: unknown) => e as IsaFlowError)
const args = (key: string, lines: Array<[string, number, number]>, extra: Record<string, unknown> = {}) => JSON.stringify({
  date: "2026-09-30", memo: "CredaFlow journals September 2026 [credaflow:b1]",
  lines: lines.map(([account_id, debit, credit]) => ({ account_id, debit, credit })), idempotency_key: key, ...extra,
})

describe("fake IsaFlow answers in the contract's shapes", () => {
  beforeAll(async () => {
    const url = await fake.start()
    vi.stubEnv("ISAFLOW_ALLOWED_ORIGINS", url)
    vi.stubEnv("NODE_ENV", "test")
    isa = mcpTransport({ baseUrl: url, token: "pat_full" })
  })
  afterAll(async () => {
    vi.unstubAllEnvs()
    await fake.stop()
  })

  const [a, b] = [() => fake.accounts[0].id, () => fake.accounts[1].id]

  it("list_companies: exactly one company, the token's", async () => {
    expect(await isa.company()).toEqual({ company_id: fake.companyId, name: fake.companyName, vat_number: "4000000000" })
  })

  it("list_gl_accounts: ordered by code, paged by next_cursor at 500, inactive only on request", async () => {
    const all = await isa.listGlAccounts()
    expect(all).toHaveLength(1202)
    expect(all.at(-1)).toMatchObject({ account_code: "99999", is_active: false })
    expect(fake.calls.filter((c) => c.tool === "list_gl_accounts")).toHaveLength(3)
    const activeOnly = parseGlAccountsPage(await callTool({ baseUrl: fake.url, token: "pat_full" }, "list_gl_accounts", "{}"))
    expect(activeOnly).toMatchObject({ total: 1201, next_cursor: expect.any(String) })
    expect(activeOnly.accounts).toHaveLength(200)
  })

  it("create_draft_journal: a draft; the same key and args replay it; other args under the key are refused", async () => {
    const first = await isa.createDraftJournal(args("k1", [[a(), 10.5, 0], [b(), 0, 10.5]]))
    expect(first).toMatchObject({ status: "draft", entryNumber: expect.stringMatching(/^JE-2026-\d{5}$/) })
    // Key order does not matter: IsaFlow hashes canonical args.
    const reordered = JSON.stringify({ idempotency_key: "k1", ...JSON.parse(args("k1", [[a(), 10.5, 0], [b(), 0, 10.5]])) })
    expect((await isa.createDraftJournal(reordered)).id).toBe(first.id)
    const conflict = await failure(isa.createDraftJournal(args("k1", [[a(), 11, 0], [b(), 0, 11]])))
    expect(conflict).toMatchObject({ kind: "definite", message: expect.stringContaining(TEXTS.keyConflict) })
    expect(fake.listDrafts()).toHaveLength(1)
  })

  it("a refusal frees the key; a write without a key, unbalanced, or on a foreign account is refused", async () => {
    fake.failNext("refuse")
    await failure(isa.createDraftJournal(args("k2", [[a(), 1, 0], [b(), 0, 1]])))
    await expect(isa.createDraftJournal(args("k2", [[a(), 1, 0], [b(), 0, 1]]))).resolves.toMatchObject({ status: "draft" })
    expect((await failure(isa.createDraftJournal(JSON.stringify({ date: "2026-09-30", lines: [] })))).message).toContain(TEXTS.keyRequired)
    expect((await failure(isa.createDraftJournal(args("k3", [[a(), 1, 0], [b(), 0, 2]])))).message).toContain("not balanced")
    expect((await failure(isa.createDraftJournal(args("k4", [[a(), 1, 0], ["00000000-0000-4000-8000-000000000000", 0, 1]])))).message).toContain(TEXTS.accountsNotOwned)
  })

  it("the company_id assertion refuses a token bound elsewhere, before the key is used", async () => {
    const wrong = await failure(isa.createDraftJournal(args("k5", [[a(), 1, 0], [b(), 0, 1]], { company_id: "00000000-0000-4000-8000-000000000001" })))
    expect(wrong.message).toContain("does not match this token's company")
    await expect(isa.createDraftJournal(args("k5", [[a(), 1, 0], [b(), 0, 1]], { company_id: fake.companyId }))).resolves.toMatchObject({ status: "draft" })
  })

  it("list_journals: drafts of the day with lines in rands; a deleted draft is gone but its key still replays", async () => {
    const before = parseJournalsPage(await callTool({ baseUrl: fake.url, token: "pat_full" }, "list_journals", JSON.stringify({ from_date: "2026-09-30", to_date: "2026-09-30", status: "draft", include_lines: true })))
    const first = before.journals.at(-1)!
    expect(first.lines).toEqual([
      expect.objectContaining({ accountId: a(), debit: 10.5, credit: 0 }),
      expect.objectContaining({ accountId: b(), debit: 0, credit: 10.5 }),
    ])
    fake.deleteDraft(first.id)
    expect((await isa.listDraftJournals("2026-09-30")).map((j) => j.id)).not.toContain(first.id)
    expect((await isa.createDraftJournal(args("k1", [[a(), 10.5, 0], [b(), 0, 10.5]]))).id).toBe(first.id)
  })

  it("auth, scope, connector and rate refusals; a dropped connection after commit is an unknown outcome", async () => {
    expect(await failure(mcpTransport({ baseUrl: fake.url, token: "pat_nobody" }).company())).toMatchObject({ kind: "auth", status: 401 })
    const scope = await failure(mcpTransport({ baseUrl: fake.url, token: "pat_read" }).createDraftJournal(args("k6", [[a(), 1, 0], [b(), 0, 1]])))
    expect(scope).toMatchObject({ kind: "auth", message: expect.stringContaining(TEXTS.insufficientScope(SCOPES.WRITE_JOURNALS)) })
    fake.failNext("disabled", "list_companies")
    expect(await failure(isa.company())).toMatchObject({ kind: "definite", message: expect.stringContaining("not enabled") })
    fake.failNext("rate", "list_companies")
    expect(await failure(isa.company())).toMatchObject({ kind: "definite", message: expect.stringContaining(TEXTS.rateLimited) })
    fake.failNext("500", "list_companies")
    expect(await failure(isa.company())).toMatchObject({ kind: "unknown" })
    const drafts = fake.listDrafts().length
    fake.commitThenDrop()
    expect(await failure(isa.createDraftJournal(args("k7", [[a(), 1, 0], [b(), 0, 1]])))).toMatchObject({ kind: "unknown" })
    expect(fake.listDrafts()).toHaveLength(drafts + 1)
    expect(RPC_CODES.NOT_ENABLED).toBe(-32001)
  })
})
