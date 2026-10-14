/**
 * Journal roles and the per-tenant chart-of-accounts mapping.
 *
 * Derivation (lib/accounting/derive.ts) speaks in ROLES; a lender's
 * AccountingAccountMapping row turns a role into its own account code. A role
 * the lender has not mapped uses the default code below. Roles are stable
 * keys: posted totals are compared per role, so remapping a code between
 * periods never re-posts history.
 */

export const ACCOUNT_ROLES = [
  "BANK",
  "LOAN_BOOK",
  "UNALLOCATED_RECEIPTS",
  "CREDIT_LIFE_PAYABLE",
  "INTEREST_INCOME",
  "FEE_INCOME",
  "DEFAULT_INTEREST_INCOME",
  "DEFAULT_FEE_INCOME",
  "BAD_DEBT_RECOVERY",
  "BAD_DEBT_EXPENSE",
  "WAIVER_EXPENSE",
] as const

export type AccountRole = (typeof ACCOUNT_ROLES)[number]

export interface AccountDefault {
  code: string
  name: string
  description: string
}

/** Sensible defaults: an asset/liability/income/expense numbering most SA charts accept. */
export const DEFAULT_ACCOUNTS: Record<AccountRole, AccountDefault> = {
  BANK: { code: "1000", name: "Bank", description: "Cash paid out and received" },
  LOAN_BOOK: { code: "1100", name: "Loans receivable", description: "Everything borrowers owe: principal plus interest, fees, premiums and charges once due" },
  UNALLOCATED_RECEIPTS: { code: "2150", name: "Unallocated receipts", description: "Money received and not yet applied to a loan, or owed back as a refund" },
  CREDIT_LIFE_PAYABLE: { code: "2200", name: "Credit life premiums payable", description: "Bundled credit-life premiums collected for the insurer" },
  INTEREST_INCOME: { code: "4000", name: "Interest income", description: "Contractual interest as instalments fall due" },
  FEE_INCOME: { code: "4010", name: "Fee income", description: "Initiation and monthly service fees" },
  DEFAULT_INTEREST_INCOME: { code: "4020", name: "Default interest income", description: "Default interest charged after a missed instalment" },
  DEFAULT_FEE_INCOME: { code: "4030", name: "Default charges income", description: "Post-default service fees, letter and collection fees" },
  BAD_DEBT_RECOVERY: { code: "4900", name: "Bad debts recovered", description: "Money received on a written-off loan" },
  BAD_DEBT_EXPENSE: { code: "6000", name: "Bad debts written off", description: "Loan balances written off" },
  WAIVER_EXPENSE: { code: "6010", name: "Balances waived", description: "Sub-R1 residues closed by a waiver" },
}

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === "string" && (ACCOUNT_ROLES as readonly string[]).includes(value)
}

export interface ResolvedAccount {
  role: AccountRole
  code: string
  name: string
  taxCode: string | null
  isDefault: boolean
}

export type AccountMap = Record<AccountRole, ResolvedAccount>

export interface MappingRow {
  role: string
  accountCode: string
  accountName: string | null
  taxCode: string | null
}

/** The tenant's map: its rows over the defaults. Unknown roles in storage are ignored. */
export function resolveAccountMap(rows: MappingRow[]): AccountMap {
  const byRole = new Map(rows.filter((r) => isAccountRole(r.role)).map((r) => [r.role as AccountRole, r]))
  const entries = ACCOUNT_ROLES.map((role): [AccountRole, ResolvedAccount] => {
    const row = byRole.get(role)
    return [role, row
      ? { role, code: row.accountCode, name: row.accountName ?? DEFAULT_ACCOUNTS[role].name, taxCode: row.taxCode, isDefault: false }
      : { role, code: DEFAULT_ACCOUNTS[role].code, name: DEFAULT_ACCOUNTS[role].name, taxCode: null, isDefault: true }]
  })
  return Object.fromEntries(entries) as AccountMap
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9 .\-/]{0,29}$/
const TAX = /^[A-Za-z0-9][A-Za-z0-9 _\-]{0,29}$/

export type MappingInput = { role: AccountRole; accountCode: string; accountName: string | null; taxCode: string | null }

/** Validates a PUT body: `{ mappings: [{ role, accountCode, accountName?, taxCode? }] }`. */
export function parseMappingInput(body: unknown): { ok: true; rows: MappingInput[] } | { ok: false; error: string } {
  const list = (body as { mappings?: unknown } | null)?.mappings
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "mappings must be a non-empty list" }
  const seen = new Set<string>()
  const rows: MappingInput[] = []
  for (const item of list) {
    const { role, accountCode, accountName, taxCode } = (item ?? {}) as Record<string, unknown>
    if (!isAccountRole(role)) return { ok: false, error: `Unknown account role: ${String(role)}` }
    if (seen.has(role)) return { ok: false, error: `${role} is listed twice` }
    seen.add(role)
    const code = typeof accountCode === "string" ? accountCode.trim() : ""
    if (!CODE.test(code)) return { ok: false, error: `${role}: account code must be 1-30 letters, digits, spaces, dots, dashes or slashes` }
    const name = typeof accountName === "string" && accountName.trim() ? accountName.trim().slice(0, 80) : null
    const tax = typeof taxCode === "string" && taxCode.trim() ? taxCode.trim() : null
    if (tax !== null && !TAX.test(tax)) return { ok: false, error: `${role}: tax code must be 1-30 letters, digits, spaces, dashes or underscores` }
    rows.push({ role, accountCode: code, accountName: name, taxCode: tax })
  }
  return { ok: true, rows }
}
