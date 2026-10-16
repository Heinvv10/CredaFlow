/**
 * The loan book a role without `view_loan_book` may not read
 * (lib/registry/permissions/050-insurance-officer-scope.ts): its staff pages
 * and their APIs, by first path segment. proxy.ts enforces it for every
 * request, page, API and server action alike; the sidebar hides the same
 * pages. Client-safe: no server imports.
 *
 * A new top-level staff page or API must be classified here or in OPEN
 * (lib/security/loan-book-scope.test.ts fails until it is).
 */
import { canDo, ROLE_HIERARCHY, type UserRole } from "@/lib/permissions"

export const LOAN_BOOK_PAGES = [
  "dashboard", "applications", "loans", "payments", "collections", "disbursements",
  "asset-finance", "reports", "crm", "contacts",
] as const

export const LOAN_BOOK_APIS = [
  "applications", "loans", "payments", "collections", "collections-engine", "asset-finance",
  "reports", "crm", "payouts", "accounting", "agent-tasks",
] as const

/** Where a role without the loan book lands instead of the executive dashboard. */
export const NO_LOAN_BOOK_HOME = "/clients"

const firstSegment = (path: string, offset: number) => path.split("/")[offset] ?? ""

export function isLoanBookPath(path: string): boolean {
  if (path.startsWith("/api/")) return (LOAN_BOOK_APIS as readonly string[]).includes(firstSegment(path, 2))
  return (LOAN_BOOK_PAGES as readonly string[]).includes(firstSegment(path, 1))
}

/**
 * A lender staff role that may not read the loan book. Not CLIENT, and not the
 * operator roles: their access to a lender is its own support grant
 * (lib/operator/tenant-access.ts), untouched here.
 */
export function lacksLoanBook(role: string | null | undefined): boolean {
  return ROLE_HIERARCHY.includes(role as UserRole) && !canDo(role as UserRole, "view_loan_book")
}
