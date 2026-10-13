import Link from "next/link"
import { Header } from "@/components/layout/Header"
import { LoanTable } from "@/components/loans/LoanTable"
import { prisma } from "@/lib/prisma"
import { getDefaultTenantId } from "@/lib/tenant"

interface PageProps { searchParams: Promise<{ branch?: string }> }

async function getLoans(tenantId: string, branchId?: string) {
  return prisma.loan.findMany({
    where: branchId
      ? { tenantId, application: { branchId } }
      : { tenantId },
    orderBy: { createdAt: "desc" },
    include: {
      client: { select: { firstName: true, lastName: true } },
      entity: { select: { legalName: true } },
      product: { select: { name: true } },
    },
  })
}

async function getBranches(tenantId: string) {
  return prisma.branch.findMany({ where: { tenantId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, code: true } })
}

export default async function LoansPage({ searchParams }: PageProps) {
  const { branch } = await searchParams
  const tenantId = await getDefaultTenantId()
  const [loans, branches] = await Promise.all([getLoans(tenantId, branch), getBranches(tenantId)])

  return (
    <>
      <Header title="Loans" subtitle="Manage active and historical loans" />
      <div className="p-4 lg:p-8">
        {branches.length > 0 && (
          <div className="mb-4 flex items-center gap-3">
            <span className="text-sm text-[var(--cf-text-muted)]">Branch:</span>
            <div className="flex gap-2 flex-wrap">
              <Link href="/loans" className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${!branch ? "border-[var(--cf-border-strong)] bg-[var(--cf-brand)] text-[var(--cf-on-brand)]" : "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] text-[var(--cf-text-secondary)] hover:border-[var(--cf-border-strong)]"}`}>All</Link>
              {branches.map((b) => (
                <Link key={b.id} href={`/loans?branch=${b.id}`}
                  className={`rounded-md border px-3 py-1 text-xs font-medium transition-colors ${branch === b.id ? "border-[var(--cf-border-strong)] bg-[var(--cf-brand)] text-[var(--cf-on-brand)]" : "border-[var(--cf-border-subtle)] bg-[var(--cf-bg-panel)] text-[var(--cf-text-secondary)] hover:border-[var(--cf-border-strong)]"}`}>
                  {b.name}
                </Link>
              ))}
            </div>
          </div>
        )}
        <LoanTable loans={loans} />
      </div>
    </>
  )
}
