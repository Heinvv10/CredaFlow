import { describe, expect, it } from "vitest"
import {
  ACCOUNT_ROLES, ASSET_FINANCE_ROLES, DEFAULT_ACCOUNTS, EXPLICIT_VAT_ROLES, NOT_CARRIED_AT_OPENING, parseMappingInput, RECEIVABLE_ROLES, resolveAccountMap,
} from "./accounts"

const map = (role: string, extra: Record<string, unknown> = {}) => parseMappingInput({ mappings: [{ role, accountCode: "1234", ...extra }] })

describe("asset-finance account roles", () => {
  it("are appended after the consumer roles, so earlier roles keep their place in every journal", () => {
    expect(ACCOUNT_ROLES.slice(0, 14).at(-1)).toBe("WAIVER_EXPENSE")
    expect(ASSET_FINANCE_ROLES).toEqual(ACCOUNT_ROLES.slice(14))
    expect(ASSET_FINANCE_ROLES).toHaveLength(16)
  })

  it("have the default codes of the design, each distinct from every other default", () => {
    const codes = ACCOUNT_ROLES.map((r) => DEFAULT_ACCOUNTS[r].code)
    expect(new Set(codes).size).toBe(codes.length)
    expect(DEFAULT_ACCOUNTS).toMatchObject({
      AF_INSTALMENT_DEBTORS: { code: "1110" }, LEASE_DEBTORS: { code: "1120" }, INPUT_VAT: { code: "1300" }, LEASED_ASSETS: { code: "1500" },
      ASSET_DISPOSAL_PROCEEDS: { code: "4600" }, RENTAL_INCOME: { code: "4100" }, MAINTENANCE_INCOME: { code: "4110" }, MAINTENANCE_FUND_LIABILITY: { code: "2400" },
      MAINTENANCE_EXPENSE: { code: "6100" }, RECOVERY_CLEARING: { code: "2500" }, RECOVERY_COSTS_PAYABLE: { code: "2510" }, RECOVERY_COST_EXPENSE: { code: "6200" },
      RECOVERY_COSTS_RECHARGED: { code: "6210" }, RECOVERY_REFUND_PAYABLE: { code: "2520" }, RECOVERY_RESULT: { code: "6300" }, AF_PRICE_CREDITS: { code: "6400" },
    })
    expect(resolveAccountMap([]).RENTAL_INCOME).toMatchObject({ code: "4100", isDefault: true })
  })

  it("keep the receivables that carry over at go-live and let the income and expense history net into opening equity", () => {
    expect(RECEIVABLE_ROLES).toEqual(["LOAN_BOOK", "AF_INSTALMENT_DEBTORS", "LEASE_DEBTORS"])
    for (const role of ["RENTAL_INCOME", "MAINTENANCE_INCOME", "MAINTENANCE_EXPENSE", "RECOVERY_COST_EXPENSE", "RECOVERY_COSTS_RECHARGED", "RECOVERY_RESULT", "ASSET_DISPOSAL_PROCEEDS", "AF_PRICE_CREDITS"] as const) {
      expect(NOT_CARRIED_AT_OPENING).toContain(role)
    }
    for (const role of ["AF_INSTALMENT_DEBTORS", "LEASE_DEBTORS", "INPUT_VAT", "LEASED_ASSETS", "RECOVERY_CLEARING", "MAINTENANCE_FUND_LIABILITY"] as const) {
      expect(NOT_CARRIED_AT_OPENING).not.toContain(role)
    }
  })

  it("refuse a tax code, because their VAT is posted as its own line and Xero would count it twice", () => {
    for (const role of EXPLICIT_VAT_ROLES) {
      expect(map(role, { taxCode: "OUTPUT2" }), role).toEqual({ ok: false, error: expect.stringContaining("count VAT twice") })
      expect(map(role).ok, role).toBe(true)
    }
    // The consumer roles keep their rules: a tax code on a fee role without a VAT split is still allowed.
    expect(map("FEE_INCOME", { taxCode: "OUTPUT2" }).ok).toBe(true)
    expect(map("OUTPUT_VAT", { taxCode: "OUTPUT2" }).ok).toBe(true)
  })

  it("can never be marked VAT-inclusive", () => {
    expect(map("RENTAL_INCOME", { vatInclusive: true })).toEqual({ ok: false, error: expect.stringContaining("only fee income") })
  })
})
