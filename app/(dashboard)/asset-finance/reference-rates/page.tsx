import Link from "next/link"
import { Percent } from "lucide-react"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { prisma } from "@/lib/prisma"
import { canDo } from "@/lib/auth-guards"
import { formatDateTime } from "@/lib/utils"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { RATE_BASIS_LABELS, ratePercent, type Tone } from "@/lib/asset-finance/deal-labels"
import { statusLabel } from "@/lib/asset-finance/labels"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { ReferenceRateDecision } from "./ReferenceRateDecision"
import { ReferenceRateForm } from "./ReferenceRateForm"

const PAGE_SIZE = 50
const STATUS_TONE: Record<string, Tone> = { PENDING: "warning", APPROVED: "success", REJECTED: "neutral" }

function offsetOf(raw: string | string[] | undefined): number {
  const n = Number(Array.isArray(raw) ? raw[0] : raw ?? 0)
  return Number.isInteger(n) && n >= 0 ? n : 0
}

/**
 * The tenant's reference-rate history (DESIGN D4), by basis then newest first,
 * as GET /api/asset-finance/reference-rates orders it. A decide_asset_finance
 * user records a value, or the Reserve Bank feed does (source SARB_FEED,
 * lib/asset-finance/rate-feed-sync.ts); a user other than the recorder
 * approves or rejects it.
 */
export default async function ReferenceRatesPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { user, tenantId } = await requireAssetFinanceStaffPage()
  const canDecide = canDo(user.role, "decide_asset_finance")
  const offset = offsetOf((await searchParams).offset)
  const rows = await prisma.referenceRate.findMany({
    where: { tenantId },
    orderBy: [{ basis: "asc" }, { effectiveDate: "desc" }, { id: "asc" }],
    skip: offset,
    take: PAGE_SIZE + 1,
  })
  const page = rows.slice(0, PAGE_SIZE)
  const more = rows.length > PAGE_SIZE

  const staffIds = [...new Set(page.flatMap((r) => [r.requestedById, r.decidedById]).filter((v): v is string => !!v))]
  const staff = await prisma.user.findMany({ where: { tenantId, id: { in: staffIds } }, select: { id: true, name: true, email: true } })
  const recordedBy = (r: (typeof page)[number]) => (r.source === "SARB_FEED" ? "SARB feed" : who(r.requestedById))
  const who = (id: string | null) => {
    if (!id) return "—"
    const found = staff.find((s) => s.id === id)
    return found ? (found.name ?? found.email) : "Unknown user"
  }

  return (
    <>
      <Header
        title="Reference rates"
        subtitle="Prime, repo, JIBAR, ZARONIA and the lender's base rate. Prime, repo and ZARONIA are fetched from the Reserve Bank and dated the day the feed showed them (check the date before approving); every value needs a person's approval before loans reprice on it"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Reference rates" }]}
      />
      <div className="space-y-6 p-4 lg:p-8">
        {canDecide && (
          <DataPanel title="Record a rate" density="loose">
            <ReferenceRateForm />
          </DataPanel>
        )}

        {page.length === 0 ? (
          <EmptyState
            icon={Percent}
            title="No reference rates yet"
            description={canDecide
              ? "Record the current prime rate before you structure a prime-linked deal."
              : "A user with the decide permission records the reference rates."}
          />
        ) : (
          <DataPanel title="History" density="compact">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Basis</TableHead>
                  <TableHead>Effective from</TableHead>
                  <TableHead className="text-right">Rate</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Recorded by</TableHead>
                  <TableHead>Decided</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="font-medium">{RATE_BASIS_LABELS[r.basis]}</TableCell>
                    <TableCell className="font-mono text-xs">{isoOfDbDate(r.effectiveDate)}</TableCell>
                    <TableCell className="text-right font-mono">{ratePercent(r.rate.toString())}</TableCell>
                    <TableCell><StatusPill tone={STATUS_TONE[r.status] ?? "neutral"}>{statusLabel(r.status)}</StatusPill></TableCell>
                    <TableCell>{recordedBy(r)}</TableCell>
                    <TableCell className="text-xs text-[var(--cf-text-secondary)]">
                      {r.decidedAt ? `${who(r.decidedById)} · ${formatDateTime(r.decidedAt)}` : "—"}
                    </TableCell>
                    <TableCell>
                      {r.status === "PENDING" && canDecide && r.requestedById !== user.id && <ReferenceRateDecision rateId={r.id} />}
                      {r.status === "PENDING" && r.requestedById === user.id && (
                        <span className="text-xs text-[var(--cf-warning)]">You recorded this; a different user must approve it.</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {(offset > 0 || more) && (
              <div className="mt-3 flex justify-between text-sm">
                {offset > 0
                  ? <Link className="text-[var(--cf-brand)] hover:underline" href={`/asset-finance/reference-rates?offset=${Math.max(0, offset - PAGE_SIZE)}`}>← Previous</Link>
                  : <span />}
                {more && <Link className="text-[var(--cf-brand)] hover:underline" href={`/asset-finance/reference-rates?offset=${offset + PAGE_SIZE}`}>Next →</Link>}
              </div>
            )}
          </DataPanel>
        )}
      </div>
    </>
  )
}
