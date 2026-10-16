import { requireLoanBookPage } from "@/lib/auth-guards"

// Loan book (lib/security/loan-book-scope.ts): a role without view_loan_book
// is refused here as well as in proxy.ts.
export default async function LoanBookLayout({ children }: { children: React.ReactNode }) {
  await requireLoanBookPage()
  return <>{children}</>
}
