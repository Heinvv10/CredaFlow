import { describe, expect, it } from "vitest"
import type { StoredLine } from "../csv"
import type { GlAccountRow, JournalListEntry } from "./contract"
import { buildDraftJournal, findPushedDraft, isaflowIdempotencyKey, netByAccount, randsAmount, resolveChart } from "./journal"

const line = (accountCode: string, debitCents: number, creditCents: number, role = "BANK"): StoredLine => ({
  lineNo: 0, postingDate: "2026-09-30", accountCode, taxCode: null, debitCents, creditCents, reference: "r", description: "d", eventKey: "e", role,
})
const account = (code: string, id: string, active = true): GlAccountRow => ({ id, account_code: code, account_name: code, account_type: "asset", account_subtype: null, is_active: active, parent_account_id: null })
const ids = new Map([["1000", "u-1000"], ["1100", "u-1100"], ["4000", "u-4000"]])
const draft = (lines = [line("1100", 233_850, 0), line("1000", 0, 200_000), line("4000", 0, 33_850)]) =>
  buildDraftJournal({ batchId: "b1", label: "September 2026", date: "2026-09-30", companyId: "c-1", lines: netByAccount(lines), accountIds: ids })

describe("IsaFlow draft journal", () => {
  it("writes rands to two decimals from whole cents", () => {
    expect([1, 10, 99, 100, 233_850, 123_456_789].map(randsAmount)).toEqual([0.01, 0.1, 0.99, 1, 2338.5, 1_234_567.89])
    expect(JSON.stringify(randsAmount(30))).toBe("0.3")
  })

  it("nets each account and drops accounts that did not move", () => {
    const net = netByAccount([line("1100", 500, 0), line("1100", 0, 200), line("2000", 300, 0), line("2000", 0, 300), line("1000", 0, 300)])
    expect(net).toEqual([{ code: "1000", debitCents: 0, creditCents: 300 }, { code: "1100", debitCents: 300, creditCents: 0 }])
  })

  it("builds one stable request: debit or credit per line, the memo tag, the batch key and the company assertion", () => {
    const a = draft()
    expect(a.argsJson).toBe(draft().argsJson)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.parse(a.argsJson)).toEqual({
      date: "2026-09-30",
      memo: "CredaFlow journals September 2026 [credaflow:b1]",
      lines: [
        { account_id: "u-1000", debit: 0, credit: 2000, description: "CredaFlow 1000" },
        { account_id: "u-1100", debit: 2338.5, credit: 0, description: "CredaFlow 1100" },
        { account_id: "u-4000", debit: 0, credit: 338.5, description: "CredaFlow 4000" },
      ],
      idempotency_key: "credaflow:batch:b1",
      company_id: "c-1",
    })
    expect(isaflowIdempotencyKey("b1")).toBe("credaflow:batch:b1")
  })

  it("refuses an unbalanced or empty journal rather than sending it", () => {
    expect(() => draft([line("1100", 100, 0), line("1000", 0, 99)])).toThrow(/does not balance/)
    expect(() => draft([line("1100", 100, 0), line("1100", 0, 100)])).toThrow(/nothing to push/)
  })

  it("maps codes to account ids only when each exists once and is active", () => {
    const chart = [account("1000", "u1"), account("1100", "u2"), account("4000", "u3", false), account("4010", "u4"), account("4010", "u5")]
    expect(resolveChart(["1000", "1100"], chart)).toEqual({ ok: true, ids: new Map([["1000", "u1"], ["1100", "u2"]]) })
    expect(resolveChart(["1000", "4000", "4010", "9999"], chart)).toEqual({ ok: false, missing: ["9999"], inactive: ["4000"], ambiguous: ["4010"] })
  })

  it("finds the draft on read-back by its memo tag and identical lines; a tagged draft with other lines is not it", () => {
    const { argsJson } = draft()
    const entry = (description: string, lines: Array<[string, number, number]>): JournalListEntry => ({
      id: "j-1", entryNumber: "JE-1", entryDate: "2026-09-30", description, source: "manual", status: "draft", amount: 0,
      lines: lines.map(([accountId, debit, credit]) => ({ accountId, accountCode: null, accountName: null, debit, credit, description: null })),
    })
    const same: Array<[string, number, number]> = [["u-1100", 2338.5, 0], ["u-1000", 0, 2000], ["u-4000", 0, 338.5]]
    expect(findPushedDraft([entry("other", same), entry("CredaFlow journals September 2026 [credaflow:b1]", same)], argsJson)).toMatchObject({ found: { id: "j-1" } })
    expect(findPushedDraft([entry("CredaFlow journals September 2026 [credaflow:b1]", [["u-1100", 2338.5, 0], ["u-1000", 0, 2338.5]])], argsJson)).toMatchObject({ found: null, conflicting: { id: "j-1" } })
    expect(findPushedDraft([entry("[credaflow:b10]", same)], argsJson)).toEqual({ found: null, conflicting: null })
  })
})
