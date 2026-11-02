import { notFound } from "next/navigation"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Header } from "@/components/layout/Header"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ReferenceRateDecision } from "@/app/(dashboard)/asset-finance/reference-rates/ReferenceRateDecision"
import { ReferenceRateForm } from "@/app/(dashboard)/asset-finance/reference-rates/ReferenceRateForm"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { ratePercent } from "@/lib/asset-finance/deal-labels"
import { statusLabel } from "@/lib/asset-finance/labels"
import { canDo, requireMinRole } from "@/lib/auth-guards"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { ensureActiveJurisdiction } from "@/lib/jurisdiction/load.server"
import { VARIABLE_RATE_BASES } from "@/lib/product-engine/types"
import { prisma } from "@/lib/prisma"

const BASES = { PRIME: "Prime", LENDER_BASE: "Lender base rate" }
const ENDPOINT = "/api/products/lending-rates"

/** The reference rates a non-NCA lender's variable-rate products follow. One person records a value, another approves it; only then does anything reprice. */
export default async function ProductReferenceRatesPage() {
  const user = await requireMinRole("LOAN_ADMIN")
  await ensureActiveJurisdiction()
  if (isNcaJurisdiction()) notFound()
  const rows = await prisma.referenceRate.findMany({ where: { tenantId: user.tenantId, basis: { in: [...VARIABLE_RATE_BASES] } }, orderBy: [{ basis: "asc" }, { effectiveDate: "desc" }, { id: "asc" }], take: 50 })
  const mayApprove = canDo(user.role, "approve_product_versions")
  return (
    <>
      <Header
        title="Reference rates"
        subtitle="What variable-rate loans follow. Every value needs a second person's approval; the nightly run then reprices the instalments still to come."
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Products", href: "/settings/products" }, { label: "Reference rates" }]}
      />
      <div className="space-y-6 p-4 lg:p-8">
        {canDo(user.role, "manage_product_versions") && <DataPanel title="Record a value" density="loose"><ReferenceRateForm bases={BASES} endpoint={ENDPOINT} /></DataPanel>}
        <DataPanel title="History" density="compact">
          {rows.length === 0 ? <p className="text-sm text-[var(--cf-text-muted)]">No reference rate recorded: a variable-rate product cannot be approved until one is.</p> : (
            <Table>
              <TableHeader><TableRow><TableHead>Basis</TableHead><TableHead>Effective from</TableHead><TableHead className="text-right">Rate</TableHead><TableHead>Status</TableHead><TableHead /></TableRow></TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell>{BASES[row.basis as keyof typeof BASES]}</TableCell>
                    <TableCell>{isoOfDbDate(row.effectiveDate)}</TableCell>
                    <TableCell className="text-right">{ratePercent(row.rate.toString())}</TableCell>
                    <TableCell><StatusPill tone={row.status === "APPROVED" ? "success" : row.status === "PENDING" ? "warning" : "neutral"}>{statusLabel(row.status)}</StatusPill></TableCell>
                    <TableCell>{row.status === "PENDING" && mayApprove && row.requestedById !== user.id && <ReferenceRateDecision rateId={row.id} endpoint={ENDPOINT} />}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </DataPanel>
      </div>
    </>
  )
}
