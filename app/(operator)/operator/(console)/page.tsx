import Link from "next/link"
import { requireOperatorPage } from "@/lib/operator/console-auth"
import { listOperatorLenders } from "@/lib/operator/console/lenders"
import { OperatorPageTitle } from "@/components/operator/OperatorShell"
import { TenantStatusBadge } from "@/components/operator/TenantStatusBadge"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate, formatDateTime } from "@/lib/utils"

export const dynamic = "force-dynamic"

// The operator's lenders: identity, status and aggregate counts only.
export default async function OperatorLendersPage() {
  const principal = await requireOperatorPage()
  const lenders = await listOperatorLenders(principal.operatorId)

  return (
    <>
      <OperatorPageTitle
        title="Lenders"
        subtitle="Every lender your operator runs. Counts only — borrower records open only through a lender's support grant."
        actions={principal.role === "OPERATOR_ADMIN" ? (
          <Link href="/operator/lenders/new" className="rounded-md bg-[var(--cf-brand)] px-4 py-2 text-sm font-semibold text-[var(--cf-on-brand)] hover:bg-[var(--cf-brand-alt)]">New lender</Link>
        ) : null}
      />
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lender</TableHead>
              <TableHead>Slug</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="text-right">Active loans</TableHead>
              <TableHead className="text-right">Clients</TableHead>
              <TableHead>Last staff sign-in</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {lenders.length === 0 ? (
              <TableRow><TableCell colSpan={7} className="text-center text-[var(--cf-text-muted)]">No lenders yet.</TableCell></TableRow>
            ) : lenders.map((l) => (
              <TableRow key={l.id}>
                <TableCell><Link href={`/operator/lenders/${l.id}`} className="font-medium text-[var(--cf-brand-alt)] hover:underline">{l.name}</Link></TableCell>
                <TableCell className="font-mono text-xs">{l.slug}</TableCell>
                <TableCell><TenantStatusBadge status={l.status} /></TableCell>
                <TableCell>{formatDate(l.createdAt)}</TableCell>
                <TableCell className="text-right tabular-nums">{l.activeLoans}</TableCell>
                <TableCell className="text-right tabular-nums">{l.clients}</TableCell>
                <TableCell>{l.lastActivityAt ? formatDateTime(l.lastActivityAt) : "—"}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </Card>
    </>
  )
}
