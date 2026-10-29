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
  "PAYOUT_CLEARING",
  "LOAN_BOOK",
  "UNALLOCATED_RECEIPTS",
  "CREDIT_LIFE_PAYABLE",
  "OUTPUT_VAT",
  "OPENING_BALANCE_EQUITY",
  "INTEREST_INCOME",
  "FEE_INCOME",
  "DEFAULT_INTEREST_INCOME",
  "DEFAULT_FEE_INCOME",
  "BAD_DEBT_RECOVERY",
  "BAD_DEBT_EXPENSE",
  "WAIVER_EXPENSE",
  // Asset finance (slice 4b). Appended: lines order by this list, so earlier roles keep their place.
  "AF_INSTALMENT_DEBTORS",
  "LEASE_DEBTORS",
  "INPUT_VAT",
  "LEASED_ASSETS",
  "ASSET_DISPOSAL_PROCEEDS",
  "RENTAL_INCOME",
  "MAINTENANCE_INCOME",
  "MAINTENANCE_FUND_LIABILITY",
  "MAINTENANCE_EXPENSE",
  "RECOVERY_CLEARING",
  "RECOVERY_COSTS_PAYABLE",
  "RECOVERY_COST_EXPENSE",
  "RECOVERY_COSTS_RECHARGED",
  "RECOVERY_REFUND_PAYABLE",
  "RECOVERY_RESULT",
  "AF_PRICE_CREDITS",
  // Dealer commission (slice 5). Appended for the same reason; VAT on commission posts to INPUT_VAT.
  "DEALER_COMMISSION_EXPENSE",
  "DEALER_COMMISSION_PAYABLE",
  // IFRS 9 (lib/ifrs9). Appended likewise; IFRS9_ROLES names them, and ASSET_FINANCE_ROLES stops before them.
  "ECL_ALLOWANCE",
  "ECL_EXPENSE",
  "INTEREST_SUSPENSE",
] as const

export type AccountRole = (typeof ACCOUNT_ROLES)[number]

/**
 * Roles whose history does not carry into the go-live month's opening entry:
 * income and expense (last year's profit is not this system's to restate) and
 * BANK (the lender's books already hold the bank balance). Their history nets
 * into OPENING_BALANCE_EQUITY, which the accountant reconciles to the legacy
 * ledger once.
 */
export const NOT_CARRIED_AT_OPENING: readonly AccountRole[] = [
  "BANK", "INTEREST_INCOME", "FEE_INCOME", "DEFAULT_INTEREST_INCOME", "DEFAULT_FEE_INCOME",
  "BAD_DEBT_RECOVERY", "BAD_DEBT_EXPENSE", "WAIVER_EXPENSE", "ECL_EXPENSE",
  "RENTAL_INCOME", "MAINTENANCE_INCOME", "MAINTENANCE_EXPENSE", "RECOVERY_COST_EXPENSE",
  "RECOVERY_COSTS_RECHARGED", "RECOVERY_RESULT", "ASSET_DISPOSAL_PROCEEDS", "AF_PRICE_CREDITS",
  "DEALER_COMMISSION_EXPENSE",
]

/**
 * IFRS 9 roles (expected credit loss allowance and expense, interest in suspense). Like the asset-finance roles
 * they are confirmed with the mapping, and a month that posts one the confirmation does not cover is refused.
 */
export const IFRS9_ROLES: readonly AccountRole[] = ["ECL_ALLOWANCE", "ECL_EXPENSE", "INTEREST_SUSPENSE"]

/** Fee income roles a lender may mark VAT-inclusive (interest is VAT-exempt). */
export const VAT_INCLUSIVE_ROLES: readonly AccountRole[] = ["FEE_INCOME", "DEFAULT_FEE_INCOME"]

/** Where a borrower's debt sits: consumer loans, instalment sales and finance leases, operating and maintenance leases. */
export const RECEIVABLE_ROLES: readonly AccountRole[] = ["LOAN_BOOK", "AF_INSTALMENT_DEBTORS", "LEASE_DEBTORS"]

/**
 * Asset-finance roles. A tenant that confirmed its mapping before they existed
 * has not confirmed these (AccountingSettings.mappingConfirmedRoles), so a month
 * that posts one is refused until the mapping is confirmed again.
 */
export const ASSET_FINANCE_ROLES: readonly AccountRole[] = ACCOUNT_ROLES.slice(ACCOUNT_ROLES.indexOf("AF_INSTALMENT_DEBTORS"), ACCOUNT_ROLES.indexOf("DEALER_COMMISSION_PAYABLE") + 1)

/**
 * Asset-finance amounts are gross or net of VAT as the source posts them, with
 * the VAT on its own INPUT_VAT / OUTPUT_VAT line, so a tax code on any of these
 * accounts would make Xero count the VAT twice.
 */
export const EXPLICIT_VAT_ROLES: readonly AccountRole[] = ASSET_FINANCE_ROLES

export interface AccountDefault {
  code: string
  name: string
  description: string
}

/** Sensible defaults: an asset/liability/equity/income/expense numbering most SA charts accept. */
export const DEFAULT_ACCOUNTS: Record<AccountRole, AccountDefault> = {
  BANK: { code: "1000", name: "Bank", description: "Cash paid out and received. In Xero map this to a clearing account: manual journals cannot post to a bank account" },
  PAYOUT_CLEARING: { code: "2100", name: "Disbursements awaiting payout", description: "Loans booked whose payout the provider has not yet confirmed paid (payout channel on)" },
  LOAN_BOOK: { code: "1100", name: "Loans receivable", description: "Everything borrowers owe: principal plus interest, fees, premiums and charges once due" },
  UNALLOCATED_RECEIPTS: { code: "2150", name: "Unallocated receipts", description: "Money received and not yet applied to a loan, or owed back as a refund" },
  CREDIT_LIFE_PAYABLE: { code: "2200", name: "Credit life premiums payable", description: "Bundled credit-life premiums owed to the insurer as they fall due; uncollected premium is reversed on write-off" },
  OUTPUT_VAT: { code: "2300", name: "VAT output", description: "VAT inside VAT-inclusive fees, when the lender is VAT-registered" },
  OPENING_BALANCE_EQUITY: { code: "3900", name: "Opening balance equity", description: "Contra of the go-live opening entry; reconcile it to the legacy ledger" },
  INTEREST_INCOME: { code: "4000", name: "Interest income", description: "Contractual interest as instalments fall due" },
  FEE_INCOME: { code: "4010", name: "Fee income", description: "Initiation and monthly service fees" },
  DEFAULT_INTEREST_INCOME: { code: "4020", name: "Default interest income", description: "Default interest charged after a missed instalment" },
  DEFAULT_FEE_INCOME: { code: "4030", name: "Default charges income", description: "Post-default service fees, letter and collection fees" },
  BAD_DEBT_RECOVERY: { code: "4900", name: "Bad debts recovered", description: "Money received on a written-off loan" },
  BAD_DEBT_EXPENSE: { code: "6000", name: "Bad debts written off", description: "Loan balances written off" },
  WAIVER_EXPENSE: { code: "6010", name: "Balances waived", description: "Sub-R1 residues closed by a waiver" },
  AF_INSTALMENT_DEBTORS: { code: "1110", name: "Instalment sale and finance lease debtors", description: "Asset finance: the financed amount plus interest as it falls due, less receipts" },
  LEASE_DEBTORS: { code: "1120", name: "Lease debtors", description: "Asset finance: rentals and end-of-term invoices once invoiced, less receipts" },
  INPUT_VAT: { code: "1300", name: "VAT input", description: "Asset finance: VAT on the dealer's invoice, on recovery costs, on repossession (s8(10)) and on a VAT-vendor dealer's commission" },
  LEASED_ASSETS: { code: "1500", name: "Assets under operating lease", description: "Cost excluding VAT of leased assets; depreciation stays in the fixed-asset register" },
  ASSET_DISPOSAL_PROCEEDS: { code: "4600", name: "Lease asset disposal proceeds", description: "Price excluding VAT of an asset sold to its lessee; derecognise its book value in the fixed-asset register" },
  RENTAL_INCOME: { code: "4100", name: "Rental income", description: "Lease rentals and end-of-term charges excluding VAT, as invoiced" },
  MAINTENANCE_INCOME: { code: "4110", name: "Maintenance income", description: "Maintenance portion of full-maintenance lease rentals excluding VAT" },
  MAINTENANCE_FUND_LIABILITY: { code: "2400", name: "Maintenance fund liability", description: "Lessee-settled maintenance funds: contributions less claims and refunds" },
  MAINTENANCE_EXPENSE: { code: "6100", name: "Maintenance claims paid", description: "Maintenance claims paid on lender-risk leases" },
  RECOVERY_CLEARING: { code: "2500", name: "Recovery clearing", description: "Repossession sales and costs, per recovery; clears to nil once the proceeds are applied or the recovery is withdrawn" },
  RECOVERY_COSTS_PAYABLE: { code: "2510", name: "Recovery costs payable", description: "Supplier invoices for recovery costs, settled through accounts payable" },
  RECOVERY_COST_EXPENSE: { code: "6200", name: "Recovery costs", description: "Recovery costs charged to the borrower's account, excluding VAT" },
  RECOVERY_COSTS_RECHARGED: { code: "6210", name: "Recovery costs recharged", description: "Contra-expense: recovery costs charged to the borrower's account" },
  RECOVERY_REFUND_PAYABLE: { code: "2520", name: "Recovery surplus refunds payable", description: "Surplus owed back to the debtor after a recovery sale" },
  RECOVERY_RESULT: { code: "6300", name: "Recovery result", description: "Gain or loss left in recovery clearing: output VAT less repossession and cost input VAT" },
  AF_PRICE_CREDITS: { code: "6400", name: "Asset-finance price credits", description: "Price excluding VAT credited to an instalment-sale or finance-lease debtor on the inception invoice; book the dealer's matching credit, if any, against it" },
  DEALER_COMMISSION_EXPENSE: { code: "6500", name: "Dealer commission", description: "Commission earned by dealers and brokers on booked asset-finance deals, excluding VAT, less clawbacks" },
  DEALER_COMMISSION_PAYABLE: { code: "2600", name: "Dealer commission payable", description: "Commission owed to dealers including VAT until a payable run is released; a clawback not yet netted is owed by the dealer" },
  ECL_ALLOWANCE: { code: "1190", name: "Loss allowance (ECL)", description: "IFRS 9 expected credit loss allowance on loans and contracts receivable: a credit balance against the receivables" },
  ECL_EXPENSE: { code: "6020", name: "Impairment charge (ECL)", description: "IFRS 9 movement in the expected credit loss allowance" },
  INTEREST_SUSPENSE: { code: "1180", name: "Interest in suspense", description: "Interest on non-performing loans accrued and not collected: held here, not in income, until collected; a credit balance against the receivables" },
}

export function isAccountRole(value: unknown): value is AccountRole {
  return typeof value === "string" && (ACCOUNT_ROLES as readonly string[]).includes(value)
}

export interface ResolvedAccount {
  role: AccountRole
  code: string
  name: string
  taxCode: string | null
  vatInclusive: boolean
  isDefault: boolean
}

export type AccountMap = Record<AccountRole, ResolvedAccount>

export interface MappingRow {
  role: string
  accountCode: string
  accountName: string | null
  taxCode: string | null
  vatInclusive?: boolean
}

/** The tenant's map: its rows over the defaults. Unknown roles in storage are ignored. */
export function resolveAccountMap(rows: MappingRow[]): AccountMap {
  const byRole = new Map(rows.filter((r) => isAccountRole(r.role)).map((r) => [r.role as AccountRole, r]))
  const entries = ACCOUNT_ROLES.map((role): [AccountRole, ResolvedAccount] => {
    const row = byRole.get(role)
    return [role, row
      ? { role, code: row.accountCode, name: row.accountName ?? DEFAULT_ACCOUNTS[role].name, taxCode: row.taxCode, vatInclusive: row.vatInclusive === true && VAT_INCLUSIVE_ROLES.includes(role), isDefault: false }
      : { role, code: DEFAULT_ACCOUNTS[role].code, name: DEFAULT_ACCOUNTS[role].name, taxCode: null, vatInclusive: false, isDefault: true }]
  })
  return Object.fromEntries(entries) as AccountMap
}

const CODE = /^[A-Za-z0-9][A-Za-z0-9 .\-/]{0,29}$/
const TAX = /^[A-Za-z0-9][A-Za-z0-9 _\-]{0,29}$/

export type MappingInput = { role: AccountRole; accountCode: string; accountName: string | null; taxCode: string | null; vatInclusive: boolean }

/** Validates a PUT body: `{ mappings: [{ role, accountCode, accountName?, taxCode?, vatInclusive? }] }`. */
export function parseMappingInput(body: unknown): { ok: true; rows: MappingInput[] } | { ok: false; error: string } {
  const list = (body as { mappings?: unknown } | null)?.mappings
  if (!Array.isArray(list) || list.length === 0) return { ok: false, error: "mappings must be a non-empty list" }
  const seen = new Set<string>()
  const rows: MappingInput[] = []
  for (const item of list) {
    const { role, accountCode, accountName, taxCode, vatInclusive } = (item ?? {}) as Record<string, unknown>
    if (!isAccountRole(role)) return { ok: false, error: `Unknown account role: ${String(role)}` }
    if (seen.has(role)) return { ok: false, error: `${role} is listed twice` }
    seen.add(role)
    const code = typeof accountCode === "string" ? accountCode.trim() : ""
    if (!CODE.test(code)) return { ok: false, error: `${role}: account code must be 1-30 letters, digits, spaces, dots, dashes or slashes` }
    const name = typeof accountName === "string" && accountName.trim() ? accountName.trim().slice(0, 80) : null
    const tax = typeof taxCode === "string" && taxCode.trim() ? taxCode.trim() : null
    if (tax !== null && !TAX.test(tax)) return { ok: false, error: `${role}: tax code must be 1-30 letters, digits, spaces, dashes or underscores` }
    const inclusive = vatInclusive === true
    if (inclusive && !VAT_INCLUSIVE_ROLES.includes(role)) return { ok: false, error: `${role}: only fee income can be marked VAT-inclusive` }
    // Splitting VAT here AND tagging a Xero tax code would count the VAT twice.
    if (inclusive && tax !== null) return { ok: false, error: `${role}: a VAT-inclusive split and a tax code together would count VAT twice; use one` }
    // Asset-finance sources post their VAT as separate INPUT_VAT / OUTPUT_VAT lines.
    if (tax !== null && EXPLICIT_VAT_ROLES.includes(role)) return { ok: false, error: `${role}: its VAT is posted as a separate line, so a tax code on this account would count VAT twice` }
    rows.push({ role, accountCode: code, accountName: name, taxCode: tax, vatInclusive: inclusive })
  }
  return { ok: true, rows }
}
