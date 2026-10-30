/**
 * The loan book a role without `view_loan_book` may not read
 * (lib/registry/permissions/050-insurance-officer-scope.ts): its staff pages
 * and their APIs, by first path segment, plus the loan-book corners of open
 * sections (LOAN_BOOK_SUBPATHS). proxy.ts enforces it for every request,
 * page, API and server action alike; the guards re-check it
 * (lib/security/loan-book-guard.ts); the sidebar hides the same pages.
 * Client-safe: no server imports.
 *
 * A new top-level staff page or API must be classified here or as open
 * (proxy.loan-book-scope.test.ts fails until it is).
 */
import { canDo, ROLE_HIERARCHY, type UserRole } from "@/lib/permissions"

export const LOAN_BOOK_PAGES = [
  "dashboard", "applications", "loans", "payments", "collections", "disbursements",
  "asset-finance", "reports", "crm", "contacts",
] as const

export const LOAN_BOOK_APIS = [
  "applications", "loans", "payments", "collections", "collections-engine", "asset-finance",
  "reports", "crm", "payouts", "accounting", "agent-tasks",
  // Client-notified payments awaiting reconciliation (#141).
  "payment-notifications",
  // IFRS 9 staging and ECL (lib/ifrs9): every loan's exposure.
  "ifrs9",
  // Approval matrix, delegations and committee packs (lib/approval): decisions on the lender's applications.
  "approval",
] as const

/**
 * Loan-book pages and APIs inside sections that are otherwise open, as path
 * segments: the NCR return is the lender's credit book in figures.
 */
export const LOAN_BOOK_SUBPATHS: readonly (readonly string[])[] = [
  ["compliance", "ncr-return"],
  ["api", "compliance", "ncr-return"],
]

/** Where a role without the loan book lands instead of the executive dashboard. */
export const NO_LOAN_BOOK_HOME = "/clients"

/**
 * The path's segments as a router sees them: percent-decoded, empty segments
 * (duplicate and trailing slashes) and "." dropped. Null when it cannot be
 * read (malformed escapes, or a ".." a router would resolve elsewhere): the
 * caller refuses rather than guess.
 */
export function pathSegments(path: string): string[] | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(path)
  } catch {
    return null
  }
  const segments = decoded.split("/").filter((s) => s !== "" && s !== ".")
  return segments.includes("..") ? null : segments
}

/**
 * Whether a request path is the loan book: its first segment (or, under /api,
 * its second) is a listed one, compared exactly and case-sensitively, as Next
 * routes. An unreadable path counts as the loan book, so a role without it is
 * refused rather than let through on a parsing difference.
 */
export function isLoanBookPath(path: string): boolean {
  const segments = pathSegments(path)
  if (!segments) return true
  if (LOAN_BOOK_SUBPATHS.some((sub) => sub.every((segment, i) => segments[i] === segment))) return true
  if (segments[0] === "api") return (LOAN_BOOK_APIS as readonly string[]).includes(segments[1] ?? "")
  return (LOAN_BOOK_PAGES as readonly string[]).includes(segments[0] ?? "")
}

/**
 * A lender staff role that may not read the loan book. Not CLIENT, and not the
 * operator roles: their access to a lender is its own support grant
 * (lib/operator/tenant-access.ts), untouched here.
 */
export function lacksLoanBook(role: string | null | undefined): boolean {
  return ROLE_HIERARCHY.includes(role as UserRole) && !canDo(role as UserRole, "view_loan_book")
}
