import { DataPanel } from "@/components/app-shell/DataPanel"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate, formatZAR } from "@/lib/utils"
import { statusLabel } from "@/lib/asset-finance/labels"
import type { EntityRecords } from "@/lib/asset-finance/entity-detail"

// The entity's applications, deals and loans, read-only. Shared by the staff
// entity page and the portal entity page; neither links into a contract yet.

function Empty({ what }: { what: string }) {
  return <p className="text-sm text-[var(--cf-text-muted)]">No {what} yet.</p>
}

export function EntityRecordsTables({ records }: { records: EntityRecords }) {
  return (
    <div className="space-y-5">
      <DataPanel title="Applications" density="compact">
        {records.applications.length === 0 ? (
          <Empty what="applications" />
        ) : (
          <Table>
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
                  <TableCell>{statusLabel(a.status)}</TableCell>
                  <TableCell>{a.ncaRegime ? statusLabel(a.ncaRegime) : "Not classified"}</TableCell>
                  <TableCell className="text-right">{formatZAR(a.appliedAmount)}</TableCell>
                  <TableCell>{formatDate(a.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataPanel>

      <DataPanel title="Deals" density="compact">
        {records.deals.length === 0 ? (
          <Empty what="deals" />
        ) : (
          <Table>
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
                  <TableCell>{statusLabel(d.status)}</TableCell>
                  <TableCell>{formatDate(d.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataPanel>

      <DataPanel title="Loans" density="compact">
        {records.loans.length === 0 ? (
          <Empty what="loans" />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Reference</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Principal</TableHead>
                <TableHead className="text-right">Outstanding</TableHead>
                <TableHead>Started</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {records.loans.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-mono text-xs">{l.reference}</TableCell>
                  <TableCell>{statusLabel(l.status)}</TableCell>
                  <TableCell className="text-right">{formatZAR(l.principal)}</TableCell>
                  <TableCell className="text-right">{formatZAR(l.outstandingPrincipal)}</TableCell>
                  <TableCell>{formatDate(l.startDate)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </DataPanel>
    </div>
  )
}
