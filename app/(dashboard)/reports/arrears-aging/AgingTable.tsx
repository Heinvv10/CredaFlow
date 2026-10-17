import Link from "next/link"
import type { Prisma } from "@prisma/client"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { arrearsBucket } from "@/lib/reports/arrears-buckets"
import { chargesOwing } from "@/lib/reports/charges-owing"
import { borrowerDisplayName } from "@/lib/borrower"
import { formatDate, formatZAR } from "@/lib/utils"

/** The rows the arrears-aging page lists, in either of its sections. */
export const AGING_LOAN_INCLUDE = {
  client: { select: { firstName: true, lastName: true, idNumber: true, phone: true } },
  entity: { select: { legalName: true } },
  product: { select: { name: true } },
} satisfies Prisma.LoanInclude

export type AgingLoan = Prisma.LoanGetPayload<{ include: typeof AGING_LOAN_INCLUDE }>

const STAGE_LABELS: Record<string, string> = {
  NONE: "No Action",
  SOFT_REMINDER: "Soft Reminder",
  FORMAL_REMINDER: "Formal Reminder",
  SECTION_129_SENT: "S.129 Issued",
  PAYMENT_ARRANGEMENT: "Arrangement",
  ATTORNEY_REFERRED: "Attorney",
  WRITTEN_OFF: "Written Off",
}

const STAGE_COLORS: Record<string, string> = {
  NONE: "var(--cf-text-muted)",
  SOFT_REMINDER: "var(--cf-info)",
  FORMAL_REMINDER: "var(--cf-warning)",
  SECTION_129_SENT: "var(--cf-danger)",
  PAYMENT_ARRANGEMENT: "var(--cf-success)",
  ATTORNEY_REFERRED: "var(--cf-brand)",
  WRITTEN_OFF: "var(--cf-text-muted)",
}

function bucketColor(days: number) {
  if (days <= 60) return "var(--cf-warning)"
  return "var(--cf-danger)"
}

export function AgingTable({ loans, chargesLive }: { loans: AgingLoan[]; chargesLive: boolean }) {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Client</TableHead>
          <TableHead>ID Number</TableHead>
          <TableHead>Product</TableHead>
          <TableHead className="text-right">DPD</TableHead>
          <TableHead>Bucket</TableHead>
          <TableHead className="text-right">Arrears</TableHead>
          {chargesLive && <TableHead className="text-right">Default charges</TableHead>}
          <TableHead className="text-right">Outstanding</TableHead>
          <TableHead>Stage</TableHead>
          <TableHead>Oldest Unpaid Due</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {loans.map((loan) => {
          const dpd = loan.daysInArrears
          const group = arrearsBucket(dpd)
          const groupColor = bucketColor(dpd)
          const stage = loan.collectionsStage ?? "NONE"
          const stageColor = STAGE_COLORS[stage] ?? "#9CA3AF"

          return (
            <TableRow key={loan.id}>
              <TableCell>
                <Link href={`/collections/${loan.id}`} className="font-medium text-[var(--cf-text)] hover:text-[var(--cf-brand-soft)]">
                  {borrowerDisplayName(loan)}
                </Link>
                <p className="text-[11px] text-[var(--cf-text-muted)]">{loan.reference}</p>
              </TableCell>
              <TableCell className="font-mono text-xs">{loan.client?.idNumber ?? "—"}</TableCell>
              <TableCell>{loan.product.name}</TableCell>
              <TableCell className="text-right font-bold" style={{ color: groupColor }}>{dpd}</TableCell>
              <TableCell>
                <span className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold" style={{ color: groupColor, background: `color-mix(in srgb, ${groupColor} 12%, transparent)` }}>
                  {group}
                </span>
              </TableCell>
              <TableCell className="text-right font-medium text-[var(--cf-danger)]">{formatZAR(loan.arrearsAmount)}</TableCell>
              {chargesLive && <TableCell className="text-right">{formatZAR(chargesOwing(loan, chargesLive))}</TableCell>}
              <TableCell className="text-right">{formatZAR(loan.outstandingPrincipal)}</TableCell>
              <TableCell>
                <span className="inline-flex items-center rounded px-2 py-0.5 text-[10px] font-semibold" style={{ color: stageColor, background: `color-mix(in srgb, ${stageColor} 12%, transparent)` }}>
                  {STAGE_LABELS[stage] ?? stage}
                </span>
              </TableCell>
              <TableCell>{loan.nextPaymentDate ? formatDate(loan.nextPaymentDate.toISOString()) : "-"}</TableCell>
            </TableRow>
          )
        })}
      </TableBody>
    </Table>
  )
}
