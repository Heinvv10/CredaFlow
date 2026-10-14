import Link from "next/link"
import { notFound } from "next/navigation"
import { operatorTenant, requireOperatorPage } from "@/lib/operator/console-auth"
import { openLenderAsSupport } from "@/lib/operator/console/support-view"
import { OperatorPageTitle } from "@/components/operator/OperatorShell"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate, formatDateTime, formatZAR } from "@/lib/utils"

export const dynamic = "force-dynamic"

const REFUSAL_TEXT: Record<string, string> = {
  no_active_grant: "You hold no active support grant for this lender. Its ADMIN grants access under Settings → Support access.",
  wrong_operator: "This lender is not run by your operator.",
  tenant_inactive: "This lender is suspended (or not yet active): support access is closed while its own staff cannot sign in.",
  totp_required: "Sign in again with two-factor authentication.",
}

// "Open lender": the lender's borrower data, read-only, through its active
// support grant only (lib/operator/console/support-view.ts). Each open is
// audited under the lender as SUPPORT_ACCESS_USED (or _REFUSED).
export default async function OperatorSupportViewPage({ params }: { params: Promise<{ id: string }> }) {
  const principal = await requireOperatorPage()
  const { id } = await params
  const tenant = await operatorTenant(principal, id)
  if (!tenant) notFound()
  const view = await openLenderAsSupport(principal, tenant.id)

  if (!view.allowed) {
    return (
      <>
        <OperatorPageTitle title={tenant.name} subtitle="Support access" />
        <Card><CardContent className="p-6 text-sm text-[var(--cf-text-secondary)]">
          {REFUSAL_TEXT[view.reason] ?? "Support access refused."}{" "}
          <Link href={`/operator/lenders/${tenant.id}`} className="text-[var(--cf-brand-alt)] hover:underline">Back</Link>
        </CardContent></Card>
      </>
    )
  }

  const { clients, loans, applications } = view.data
  return (
    <>
      <div role="status" className="mb-4 rounded-lg border border-[var(--cf-warning)] bg-[var(--cf-bg-subtle)] px-4 py-3 text-sm font-medium text-[var(--cf-text)]">
        Support access — read only, expires {formatDateTime(view.expiresAt)}. Every view is recorded in {tenant.name}&apos;s audit log.
      </div>
      <OperatorPageTitle title={tenant.name} subtitle="Most recent 50 of each. ID numbers are masked; contact details are not shown." />
      <Section title="Clients" headers={["Name", "ID number", "Created"]} rows={clients.map((c) => [`${c.firstName} ${c.lastName}`, c.idNumber, formatDate(c.createdAt)])} />
      <Section
        title="Loans"
        headers={["Reference", "Status", "Principal", "Arrears", "Days in arrears", "Start"]}
        rows={loans.map((l) => [l.reference, l.status, formatZAR(l.principal), formatZAR(l.arrearsAmount), String(l.daysInArrears), formatDate(l.startDate)])}
      />
      <Section title="Applications" headers={["Id", "Status", "Created"]} rows={applications.map((a) => [a.id, a.status, formatDate(a.createdAt)])} />
    </>
  )
}

function Section({ title, headers, rows }: { title: string; headers: string[]; rows: string[][] }) {
  return (
    <Card className="mb-4">
      <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
      <CardContent>
        <Table>
          <TableHeader><TableRow>{headers.map((h) => <TableHead key={h}>{h}</TableHead>)}</TableRow></TableHeader>
          <TableBody>
            {rows.length === 0 ? (
              <TableRow><TableCell colSpan={headers.length} className="text-[var(--cf-text-muted)]">None.</TableCell></TableRow>
            ) : rows.map((r, i) => (
              <TableRow key={i}>{r.map((cell, j) => <TableCell key={j}>{cell}</TableCell>)}</TableRow>
            ))}
          </TableBody>
        </Table>
      </CardContent>
    </Card>
  )
}
