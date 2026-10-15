import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { prisma } from "@/lib/prisma"
import { sastCalendarDate } from "@/lib/date/sast"
import { formatIsoDate } from "@/lib/asset-finance/format"
import { getLegalMatterView } from "@/lib/asset-finance/legal-matter-view"
import { AttorneyForm } from "./AttorneyForm"
import { LegalStepsTimeline } from "./LegalStepsTimeline"
import { hintText, REGIME_LABELS } from "./legal-matter-form"
import { OpenLegalMatterButton } from "./OpenLegalMatterButton"
import { RecordStepForm } from "./RecordStepForm"

/**
 * The legal matter of an asset-finance loan on the staff loan page: open it,
 * appoint the attorney, record steps (lib/asset-finance/legal-matter-*.ts).
 * Server component: it reads the matter and the tenant's suppliers; the
 * forms are client components posting to app/api/asset-finance/. `canManage`
 * is manage_asset_finance; without it the panel only reads.
 */

const subheading = "mb-3 text-xs font-semibold uppercase tracking-[0.08em] text-[var(--cf-text-muted)]"

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="break-words text-sm text-[var(--cf-text)]">{children}</dd>
    </div>
  )
}

export async function LegalMatterPanel({ tenantId, loanId, canManage }: { tenantId: string; loanId: string; canManage: boolean }) {
  const result = await getLegalMatterView(tenantId, { loanId })
  if (result.kind === "not_found") return null
  const matter = result.view

  if (!matter) {
    return (
      <DataPanel title="Legal matter" description="Court action to recover the asset or the debt." density="loose"
        actions={canManage ? <OpenLegalMatterButton loanId={loanId} /> : undefined}>
        <p className="text-sm text-[var(--cf-text-muted)]">No legal matter has been opened on this loan.</p>
      </DataPanel>
    )
  }

  const open = matter.status === "OPEN"
  const today = sastCalendarDate(new Date())
  const suppliers = canManage && open
    ? (await prisma.supplier.findMany({ where: { tenantId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }))
        .map((supplier) => ({ value: supplier.id, label: supplier.name }))
    : []

  return (
    <DataPanel title="Legal matter" description="Court action to recover the asset or the debt." density="loose"
      actions={<StatusPill tone={open ? "warning" : "neutral"}>{open ? "Open" : "Closed"}</StatusPill>}>
      <div className="space-y-6">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
          <Item label="Regime">{REGIME_LABELS[matter.regime]}</Item>
          <Item label="Attorney">
            {matter.attorney ? `${matter.attorney.name} (from ${formatIsoDate(matter.attorney.appointedOn)})` : "Not appointed"}
          </Item>
          <Item label="Case number">{matter.caseNumber ?? "-"}</Item>
          <Item label="Court">{matter.court ?? "-"}</Item>
        </dl>

        {matter.nextStep && (
          <p className="rounded-md border border-[var(--cf-border-subtle)] bg-[var(--cf-surface-soft)] p-3 text-sm text-[var(--cf-text)]">
            <span className="text-[var(--cf-text-muted)]">Next: </span>{hintText(matter.nextStep)}
          </p>
        )}

        <section>
          <h3 className={subheading}>Steps</h3>
          <LegalStepsTimeline matter={matter} />
        </section>

        {canManage && open && (
          <section>
            <h3 className={subheading}>Record step</h3>
            <RecordStepForm matter={matter} today={today} />
          </section>
        )}

        {canManage && open && (
          <section>
            <h3 className={subheading}>{matter.attorney ? "Change attorney" : "Appoint attorney"}</h3>
            <AttorneyForm key={matter.steps.length} matterId={matter.id} suppliers={suppliers} current={matter.attorney?.supplierId ?? null} today={today} />
          </section>
        )}

        {!open && <p className="text-sm text-[var(--cf-text-muted)]">This matter is closed{matter.closedAt ? ` (${formatIsoDate(sastCalendarDate(new Date(matter.closedAt)))})` : ""}.</p>}
      </div>
    </DataPanel>
  )
}
