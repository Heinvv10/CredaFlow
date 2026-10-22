import Link from "next/link"
import { notFound } from "next/navigation"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { GuideActions } from "@/components/asset-finance/valuation-guides/GuideActions"
import { prisma } from "@/lib/prisma"
import { canDo } from "@/lib/auth-guards"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { GUIDE_STATUS_LABELS, GUIDE_STATUS_TONE } from "@/lib/valuation-guides/labels"
import { clampOffset } from "@/lib/valuation-guides/guide-view"

const PAGE_SIZE = 200

/** One guide's rows in file order, so the publisher sees exactly what goes live. */
export default async function ValuationGuidePage({ params, searchParams }: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { user, tenantId } = await requireAssetFinanceStaffPage()
  const { id } = await params
  const guide = await prisma.valuationGuide.findFirst({ where: { id, tenantId } })
  if (!guide) notFound()
  const offset = clampOffset((await searchParams).offset, guide.rowCount)
  const rows = await prisma.valuationGuideRow.findMany({ where: { tenantId, guideId: id }, orderBy: { lineNumber: "asc" }, skip: offset, take: PAGE_SIZE + 1 })
  const page = rows.slice(0, PAGE_SIZE)
  const canManageGuides = canDo(user.role, "manage_valuation_guides")
  const base = `/asset-finance/valuation-guides/${id}`

  return (
    <>
      <Header
        title={guide.name}
        subtitle={`Effective ${formatIsoDate(isoOfDbDate(guide.effectiveOn))} · ${guide.rowCount.toLocaleString("en-ZA")} rows · ${guide.provider === "csv" ? "uploaded CSV" : guide.provider} · sha256 ${guide.fileSha256.slice(0, 12)}…`}
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Valuation guides", href: "/asset-finance/valuation-guides" }, { label: guide.name }]}
        actions={
          <div className="flex items-center gap-3">
            {guide.simulated && <StatusPill tone="warning">Simulated</StatusPill>}
            <StatusPill tone={GUIDE_STATUS_TONE[guide.status]}>{GUIDE_STATUS_LABELS[guide.status]}</StatusPill>
          </div>
        }
      />
      <div className="space-y-6 p-4 lg:p-8">
        {guide.status === "DRAFT" && canManageGuides && (
          <DataPanel title="Draft" description="Check the rows below before publishing. Publishing supersedes the current guide of this name." density="loose">
            {guide.uploadedById === user.id
              ? <p className="mb-3 text-sm text-[var(--cf-warning)]">You loaded this guide; another guide manager publishes it.</p>
              : null}
            <GuideActions guideId={guide.id} canPublish={guide.uploadedById !== user.id} />
          </DataPanel>
        )}
        <DataPanel title="Rows" description="Values incl. VAT, as the guide states them" density="compact">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="text-right">Line</TableHead>
                <TableHead>Make</TableHead>
                <TableHead>Model</TableHead>
                <TableHead className="text-right">Year</TableHead>
                <TableHead>Variant</TableHead>
                <TableHead className="text-right">Trade</TableHead>
                <TableHead className="text-right">Retail</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {page.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="text-right font-mono text-xs">{r.lineNumber}</TableCell>
                  <TableCell>{r.make}</TableCell>
                  <TableCell>{r.model}</TableCell>
                  <TableCell className="text-right font-mono">{r.year}</TableCell>
                  <TableCell>{r.variant || "—"}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(r.tradeCents)}</TableCell>
                  <TableCell className="text-right font-mono">{formatMoney(r.retailCents)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          {(offset > 0 || rows.length > PAGE_SIZE) && (
            <div className="mt-3 flex justify-between text-sm">
              {offset > 0 ? <Link className="text-[var(--cf-brand)] hover:underline" href={`${base}?offset=${Math.max(0, offset - PAGE_SIZE)}`}>← Previous</Link> : <span />}
              {rows.length > PAGE_SIZE && <Link className="text-[var(--cf-brand)] hover:underline" href={`${base}?offset=${offset + PAGE_SIZE}`}>Next →</Link>}
            </div>
          )}
        </DataPanel>
      </div>
    </>
  )
}
