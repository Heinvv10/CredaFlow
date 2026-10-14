/**
 * A supplier bank account as staff see it. The full account number is shown
 * only to a user with decide_asset_finance, who verifies it against the bank's
 * confirmation before approving (DESIGN D8); everyone else sees the last four
 * digits, as the audit trail does (accountNumberLast4).
 */
import { canDo, type AppRole } from "@/lib/auth-guards"

/** "62000000001" → "•••••••0001"; four digits or fewer are fully masked. */
export function maskAccountNumber(accountNumber: string): string {
  const visible = accountNumber.length > 4 ? accountNumber.slice(-4) : ""
  return "•".repeat(accountNumber.length - visible.length) + visible
}

export function canSeeFullAccountNumber(role: AppRole): boolean {
  return canDo(role, "decide_asset_finance")
}

/** The row with its account number masked unless `role` may see it whole. */
export function supplierBankAccountView<T extends { accountNumber: string }>(row: T, role: AppRole): T {
  return canSeeFullAccountNumber(role) ? row : { ...row, accountNumber: maskAccountNumber(row.accountNumber) }
}
