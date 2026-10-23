import Link from "next/link"
import { BookOpen } from "lucide-react"
import { Header } from "@/components/layout/Header"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { EmptyState } from "@/components/app-shell/EmptyState"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { GuideActions } from "@/components/asset-finance/valuation-guides/GuideActions"
import { GuideUploadForm } from "@/components/asset-finance/valuation-guides/GuideUploadForm"
import { prisma } from "@/lib/prisma"
import { canDo } from "@/lib/auth-guards"
import { formatDateTime } from "@/lib/utils"
import { isSimulationPermitted } from "@/lib/integrations/simulation-guard"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { formatIsoDate } from "@/lib/asset-finance/format"
import { requireAssetFinanceStaffPage } from "@/lib/asset-finance/staff-page"
import { GUIDE_STATUS_LABELS, GUIDE_STATUS_TONE } from "@/lib/valuation-guides/labels"

/**
 * The lender's valuation guides (docs/asset-finance/SLICE5.md part C), newest
 * upload first. A guide manager loads one as a draft; another publishes it,
 * which supersedes the current guide of that name. Deals, assets and the
 * book revaluation read the current guides.
 */
export default async function ValuationGuidesPage() {
  const { user, tenantId } = await requireAssetFinanceStaffPage()
  const canManageGuides = canDo(user.role, "manage_valuation_guides")
  const guides = await prisma.valuationGuide.findMany({ where: { tenantId }, orderBy: [{ uploadedAt: "desc" }, { id: "asc" }], take: 200 })
  const staffIds = [...new Set(guides.flatMap((g) => [g.uploadedById, g.publishedById]).filter((v): v is string => !!v))]
  const staff = await prisma.user.findMany({ where: { tenantId, id: { in: staffIds } }, select: { id: true, name: true, email: true } })
  const who = (id: string | null) => {
    const found = id ? staff.find((s) => s.id === id) : undefined
    return found ? (found.name ?? found.email) : "—"
  }

  return (
    <>
      <Header
        title="Valuation guides"
        subtitle="Dated trade and retail values by make, model, year and variant. A guide value is a reference: a lease purchase and a recovery sale still need an independent valuation"
        breadcrumbs={[{ label: "Asset Finance" }, { label: "Valuation guides" }]}
        actions={<Link href="/asset-finance/valuation-guides/revaluation" className="text-sm text-[var(--cf-brand)] hover:underline">Book revaluation →</Link>}
      />
      <div className="space-y-6 p-4 lg:p-8">
        {canManageGuides && (
          <DataPanel title="Load a guide" density="loose">
            <GuideUploadForm synthetic={isSimulationPermitted("simulated-valuation-guide")} />
          </DataPanel>
        )}

        {guides.length === 0 ? (
          <EmptyState
            icon={BookOpen}
            title="No valuation guides yet"
            description={canManageGuides ? "Load the lender's guide as a CSV; a second guide manager publishes it." : "A guide manager loads the lender's valuation guide."}
          />
        ) : (
          <DataPanel title="Guides" density="compact">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Effective from</TableHead>
                  <TableHead className="text-right">Rows</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Loaded by</TableHead>
                  <TableHead>Published</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {guides.map((g) => (
                  <TableRow key={g.id}>
                    <TableCell className="font-medium">
                      <Link href={`/asset-finance/valuation-guides/${g.id}`} className="text-[var(--cf-brand)] hover:underline">{g.name}</Link>
                      {g.simulated && <span className="ml-2"><StatusPill tone="warning">Simulated</StatusPill></span>}
                    </TableCell>
                    <TableCell className="font-mono text-xs">{formatIsoDate(isoOfDbDate(g.effectiveOn))}</TableCell>
                    <TableCell className="text-right font-mono">{g.rowCount.toLocaleString("en-ZA")}</TableCell>
                    <TableCell><StatusPill tone={GUIDE_STATUS_TONE[g.status]}>{GUIDE_STATUS_LABELS[g.status]}</StatusPill></TableCell>
                    <TableCell>{who(g.uploadedById)} · {formatDateTime(g.uploadedAt)}</TableCell>
                    <TableCell className="text-xs text-[var(--cf-text-secondary)]">{g.publishedAt ? `${who(g.publishedById)} · ${formatDateTime(g.publishedAt)}` : "—"}</TableCell>
                    <TableCell>
                      {g.status === "DRAFT" && canManageGuides && <GuideActions guideId={g.id} canPublish={g.uploadedById !== user.id} />}
                      {g.status === "DRAFT" && g.uploadedById === user.id && (
                        <span className="text-xs text-[var(--cf-warning)]">You loaded this; another guide manager publishes it.</span>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </DataPanel>
        )}
      </div>
    </>
  )
}
