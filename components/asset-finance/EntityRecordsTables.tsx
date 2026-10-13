import Link from "next/link"
import type { AssetDealStatus, NcaRegime } from "@prisma/client"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { ScrollTable } from "@/components/asset-finance/ScrollTable"
import { formatDate } from "@/lib/utils"
import { formatMoney } from "@/lib/asset-finance/format"
import { NCA_REGIME_LABELS, statusLabel } from "@/lib/asset-finance/labels"
import { DEAL_STATUS_TONE, dealStatusLabel } from "@/lib/asset-finance/deal-labels"
import type { EntityRecords } from "@/lib/asset-finance/entity-detail"

// The entity's applications, deals and loans, read-only. Shared by the staff
// entity page and the portal entity page; `loanHref`, when given, links each
// loan's reference to its contract page.

function Empty({ what }: { what: string }) {
  return <p className="text-sm text-[var(--cf-text-muted)]">No {what} yet.</p>
}

export function EntityRecordsTables({ records, loanHref }: { records: EntityRecords; loanHref?: (loanId: string) => string }) {
  return (
    <div className="space-y-5">
      <DataPanel title="Applications" density="compact">
        {records.applications.length === 0 ? (
          <Empty what="applications" />
        ) : (
          <ScrollTable maxHeight="">
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>NCA regime</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead>Captured</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.applications.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="font-mono text-xs">{a.reference}</TableCell>
                  <TableCell><StatusPill>{statusLabel(a.status)}</StatusPill></TableCell>
                  <TableCell>{a.ncaRegime ? NCA_REGIME_LABELS[a.ncaRegime as NcaRegime] ?? a.ncaRegime : "Not classified"}</TableCell>
                  <TableCell className="text-right">{formatMoney(a.appliedAmount)}</TableCell>
                  <TableCell>{formatDate(a.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ScrollTable>
        )}
      </DataPanel>

      <DataPanel title="Deals" density="compact">
        {records.deals.length === 0 ? (
          <Empty what="deals" />
        ) : (
          <ScrollTable maxHeight="">
            <TableHeader>
              <TableRow>
                <TableHead>Application</TableHead>
                <TableHead>Asset</TableHead>
                <TableHead>Contract</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Captured</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.deals.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-mono text-xs">{d.applicationReference}</TableCell>
                  <TableCell>{d.assetDescription}</TableCell>
                  <TableCell>{statusLabel(d.contractType)}</TableCell>
                  <TableCell><StatusPill tone={DEAL_STATUS_TONE[d.status as AssetDealStatus]}>{dealStatusLabel(d.status as AssetDealStatus)}</StatusPill></TableCell>
                  <TableCell>{formatDate(d.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ScrollTable>
        )}
      </DataPanel>

      <DataPanel
        title="Loans"
        description="Principal is the capital the schedule repays: the amount financed plus any interest capitalised in lower- or no-payment months, so it can be more than the amount financed. Outstanding principal is what is left of it."
        density="compact"
      >
        {records.loans.length === 0 ? (
          <Empty what="loans" />
        ) : (
          <ScrollTable maxHeight="">
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Principal</TableHead>
                <TableHead className="text-right">Outstanding principal</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.loans.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-mono text-xs">
                    {loanHref ? (
                      <Link href={loanHref(l.id)} className="text-[var(--cf-brand)] underline-offset-2 hover:underline">{l.reference}</Link>
                    ) : (
                      l.reference
                    )}
                  </TableCell>
                  <TableCell><StatusPill>{statusLabel(l.status)}</StatusPill></TableCell>
                  <TableCell className="text-right">{formatMoney(l.principal)}</TableCell>
                  <TableCell className="text-right">{formatMoney(l.outstandingPrincipal)}</TableCell>
                  <TableCell>{formatDate(l.startDate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </ScrollTable>
        )}
      </DataPanel>
    </div>
  )
}
