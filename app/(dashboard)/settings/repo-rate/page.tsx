import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { prisma } from "@/lib/prisma"
import { isNcaJurisdiction } from "@/lib/jurisdiction/active"
import { canDo, requireMinRole } from "@/lib/auth-guards"
import { formatDateTime } from "@/lib/utils"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { ratePercent, type Tone } from "@/lib/asset-finance/deal-labels"
import { statusLabel } from "@/lib/asset-finance/labels"
import { ReferenceRateDecision } from "@/app/(dashboard)/asset-finance/reference-rates/ReferenceRateDecision"
import { ReferenceRateForm } from "@/app/(dashboard)/asset-finance/reference-rates/ReferenceRateForm"

const STATUS_TONE: Record<string, Tone> = { PENDING: "warning", APPROVED: "success", REJECTED: "neutral" }

/**
 * The SARB repo rate, for every lender: the NCA interest-rate cap on
 * unsecured credit is repo + 21% a year (lib/loan/nca-interest-cap.ts). One
 * user records it (or the SARB feed does), a different one approves it; a
 * newer fed value that is lower lowers the cap before it is approved.
 */
export default async function RepoRatePage() {
  const user = await requireMinRole("LOAN_ADMIN")
  if (!isNcaJurisdiction()) notFound()
  const canManage = canDo(user.role, "manage_repo_rate")
  const rows = await prisma.referenceRate.findMany({
    where: { tenantId: user.tenantId, basis: "REPO" },
    orderBy: [{ effectiveDate: "desc" }, { id: "asc" }],
    take: 50,
  })
  const staffIds = [...new Set(rows.flatMap((r) => [r.requestedById, r.decidedById]).filter((v): v is string => !!v))]
  const staff = await prisma.user.findMany({ where: { tenantId: user.tenantId, id: { in: staffIds } }, select: { id: true, name: true, email: true } })
  const who = (id: string | null) => (id ? staff.find((s) => s.id === id)?.name ?? staff.find((s) => s.id === id)?.email ?? "Unknown user" : "—")

  return (
    <>
      <Header
        title="Repo rate"
        subtitle="The SARB repo rate sets the NCA maximum interest on unsecured credit (repo + 21% a year). Every value needs a second person's approval."
        breadcrumbs={[{ label: "Settings", href: "/settings" }, { label: "Repo rate" }]}
      />
      <div className="space-y-6 p-4 lg:p-8">
        {canManage && (
          <DataPanel title="Record the repo rate" density="loose">
            <ReferenceRateForm fixedBasis="REPO" />
          </DataPanel>
        )}
        <DataPanel title="History" density="compact">
          {rows.length === 0 ? (
            <p className="text-sm text-[var(--cf-text-muted)]">No repo rate recorded: unsecured loans cannot be priced or approved until one is approved.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Effective from</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Recorded by</TableHead>
                  <TableHead>Decided</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-mono text-xs">{isoOfDbDate(r.effectiveDate)}</TableCell>
                    <TableCell className="text-right font-mono">{ratePercent(r.rate.toString())}</TableCell>
                    <TableCell><StatusPill tone={STATUS_TONE[r.status] ?? "neutral"}>{statusLabel(r.status)}</StatusPill></TableCell>
                    <TableCell>{r.source === "SARB_FEED" ? "SARB feed" : who(r.requestedById)}</TableCell>
                    <TableCell className="text-xs text-[var(--cf-text-secondary)]">{r.decidedAt ? `${who(r.decidedById)} · ${formatDateTime(r.decidedAt)}` : "—"}</TableCell>
                    <TableCell>
                      {r.status === "PENDING" && canManage && r.requestedById !== user.id && <ReferenceRateDecision rateId={r.id} />}
                    </TableCell>
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
