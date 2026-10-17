import { requireMinRole } from "@/lib/auth-guards"
import { AttorneysTable } from "@/components/settings/AttorneysTable"
import { Header } from "@/components/layout/Header"

export const metadata = {
  title: "Attorney Firms — Settings",
}

export default async function AttorneysPage() {
  // Matches /api/settings/attorneys requireApiRole("LOAN_ADMIN"); the old
  // literal Set silently excluded BRANCH_MANAGER from a page they could
  // already mutate via direct curl.
  await requireMinRole("LOAN_ADMIN")

  return (
    <>
      <Header
        title="Attorneys"
        subtitle="Attorney firm register"
        breadcrumbs={[
          { label: "Settings", href: "/settings" },
          { label: "Attorneys" },
        ]}
      />
      <div className="p-4 lg:p-8">
        <AttorneysTable />
      </div>
    </>
  )
}
