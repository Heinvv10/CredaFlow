import { StatusPill } from "@/components/app-shell/StatusPill"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatMoney } from "@/lib/asset-finance/format"
import { statusLabel } from "@/lib/asset-finance/labels"
import type { PortalLeaseView } from "@/lib/asset-finance/portal-lease"
import { formatDate } from "@/lib/utils"

type Fund = NonNullable<PortalLeaseView["fund"]>

const CLAIM_TONE = { SUBMITTED: "warning", APPROVED: "info", PAID: "success", REJECTED: "danger" } as const

// UNTESTED: legal — what happens to the fund at the end of the term (fundSettlement, lib/asset-finance/maintenance-fund.ts).
const SETTLEMENT_NOTE: Record<Fund["riskModel"], string> = {
  LENDER_RISK: "The lessor carries the maintenance risk: a surplus in the fund stays with the lessor and a shortfall is not charged to you.",
  LESSEE_SETTLED: "At the end of the lease a surplus in the fund is refunded to you and a shortfall is invoiced to you.",
}

/** The maintenance fund of a full-maintenance lease, and the claims made against it. Read only. */
export function LeaseMaintenanceFund({ fund }: { fund: Fund }) {
  return (
    <div className="space-y-4 text-sm">
      <div>
        <p className="text-xs text-[var(--cf-text-muted)]">Maintenance fund balance</p>
        <p className="text-2xl font-semibold text-[var(--cf-text)]">{formatMoney(fund.balanceCents)}</p>
        <p className="mt-1 text-xs text-[var(--cf-text-muted)]">{SETTLEMENT_NOTE[fund.riskModel]}</p>
      </div>
      {fund.claims.length === 0 ? (
        <p className="text-[var(--cf-text-muted)]">No maintenance claims have been made.</p>
      ) : (
        <ScrollTable maxHeight="max-h-[24rem]">
          <TableHeader>
            <TableRow>
              <TableHead>Date</TableHead>
              <TableHead>Provider</TableHead>
              <TableHead>Description</TableHead>
              <TableHead className="text-right">Amount (excl. VAT)</TableHead>
              <TableHead>Status</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {fund.claims.map((c) => (
              <TableRow key={c.id}>
                <TableCell>{formatDate(c.submittedOn)}</TableCell>
                <TableCell>{c.provider}</TableCell>
                <TableCell>{c.description}</TableCell>
                <TableCell className="text-right">{formatMoney(c.amountExclVatCents)}</TableCell>
                <TableCell><StatusPill tone={CLAIM_TONE[c.status]}>{statusLabel(c.status)}</StatusPill></TableCell>
              </TableRow>
            ))}
          </TableBody>
        </ScrollTable>
      )}
    </div>
  )
}
