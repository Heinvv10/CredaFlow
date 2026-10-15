import Link from "next/link"
import { requireOperatorPage } from "@/lib/operator/console-auth"
import { operatorUsageForMonth, usageMonth } from "@/lib/operator/console/usage"
import { OperatorPageTitle } from "@/components/operator/OperatorShell"
import { TenantStatusBadge } from "@/components/operator/TenantStatusBadge"
import { Card } from "@/components/ui/card"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatZAR } from "@/lib/utils"

export const dynamic = "force-dynamic"

function shiftMonth(key: string, by: number): string {
  const [y, m] = key.split("-").map(Number)
  const index = y * 12 + (m - 1) + by
  return `${Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}`
}

// Usage and billing counts per lender for one SAST calendar month. Aggregates
// only (lib/operator/console/usage.ts defines each figure).
export default async function OperatorUsagePage({ searchParams }: { searchParams: Promise<{ month?: string }> }) {
  const principal = await requireOperatorPage()
  const month = usageMonth((await searchParams).month)
  const rows = await operatorUsageForMonth(principal.operatorId, month)
  const total = (k: "applications" | "activeLoans" | "disbursements" | "disbursedCents" | "providerApiCalls" | "messagesSent") =>
    rows.reduce((sum, r) => sum + r[k], 0)

  return (
    <>
      <OperatorPageTitle
        title={`Usage — ${month.key}`}
        subtitle="Per lender, calendar month in SAST. Active loans: on the book at any point in the month. Provider API calls: bureau, KYC, payment and other third-party calls. Messages: outbound email and WhatsApp sent."
        actions={
          <div className="flex gap-3 text-sm">
            <Link href={`/operator/usage?month=${shiftMonth(month.key, -1)}`} className="text-[var(--cf-brand-alt)] hover:underline">← {shiftMonth(month.key, -1)}</Link>
            <Link href={`/operator/usage?month=${shiftMonth(month.key, 1)}`} className="text-[var(--cf-brand-alt)] hover:underline">{shiftMonth(month.key, 1)} →</Link>
          </div>
        }
      />
      <Card>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Lender</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="text-right">Applications</TableHead>
              <TableHead className="text-right">Active loans</TableHead>
              <TableHead className="text-right">Disbursements</TableHead>
              <TableHead className="text-right">Disbursed</TableHead>
              <TableHead className="text-right">Provider API calls</TableHead>
              <TableHead className="text-right">Messages sent</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((r) => (
              <TableRow key={r.tenantId}>
                <TableCell><Link href={`/operator/lenders/${r.tenantId}`} className="text-[var(--cf-brand-alt)] hover:underline">{r.name}</Link></TableCell>
                <TableCell><TenantStatusBadge status={r.status} /></TableCell>
                <TableCell className="text-right tabular-nums">{r.applications}</TableCell>
                <TableCell className="text-right tabular-nums">{r.activeLoans}</TableCell>
                <TableCell className="text-right tabular-nums">{r.disbursements}</TableCell>
                <TableCell className="text-right tabular-nums">{formatZAR(r.disbursedCents)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.providerApiCalls}</TableCell>
                <TableCell className="text-right tabular-nums">{r.messagesSent}</TableCell>
              </TableRow>
            ))}
            <TableRow className="font-semibold">
              <TableCell colSpan={2}>Total</TableCell>
              <TableCell className="text-right tabular-nums">{total("applications")}</TableCell>
              <TableCell className="text-right tabular-nums">{total("activeLoans")}</TableCell>
              <TableCell className="text-right tabular-nums">{total("disbursements")}</TableCell>
              <TableCell className="text-right tabular-nums">{formatZAR(total("disbursedCents"))}</TableCell>
              <TableCell className="text-right tabular-nums">{total("providerApiCalls")}</TableCell>
              <TableCell className="text-right tabular-nums">{total("messagesSent")}</TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </Card>
    </>
  )
}
