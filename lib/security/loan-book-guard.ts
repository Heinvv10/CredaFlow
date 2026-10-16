/**
 * The guards' half of the loan-book scope (lib/security/loan-book-scope.ts):
 * the second layer behind proxy.ts, so a role without view_loan_book is
 * refused by requireApiRole / requireMinRole / requireRole /
 * requireOwnerOrStaff even if a request reached a handler some other way.
 * The path is the one proxy.ts stamped (REQUEST_PATH_HEADER, any client
 * value removed first); without the stamp the check fails closed.
 */
import { REQUEST_PATH_HEADER } from "@/lib/proxy/operator-read-only"
import { isLoanBookPath, lacksLoanBook } from "./loan-book-scope"

/** The stamped request path, or null outside a request or without the stamp. */
export async function stampedRequestPath(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers")
    return (await headers()).get(REQUEST_PATH_HEADER)
  } catch {
    // No request scope (a script, a test without one): no stamp, so the
    // caller fails closed for a role without the loan book.
    return null
  }
}

/** Whether this request must be refused to the role: a loan-book path, or no stamped path at all. */
export async function refusesLoanBook(role: string | null | undefined): Promise<boolean> {
  if (!lacksLoanBook(role)) return false
  const path = await stampedRequestPath()
  return path === null || isLoanBookPath(path)
}
