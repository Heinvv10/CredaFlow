import Link from "next/link"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { formatLtv } from "@/lib/valuation-guides/ltv"
import type { GuidePanelData } from "@/lib/valuation-guides/guide-panel"
import { RecordGuideValueForm } from "./RecordGuideValueForm"

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="text-sm text-[var(--cf-text)]">{children}</dd>
    </div>
  )
}

const variantOf = (variant: string) => variant || "no variant"

/**
 * The asset's value from the lender's published valuation guides
 * (docs/asset-finance/SLICE5.md part C): the latest recorded GUIDE valuation,
 * on a deal the goods advance and its LTV against it, and the current guide
 * rows to record from. Display only; a guide value is never an independent
 * valuation (a lease purchase and a recovery sale refuse it).
 */
export function GuideValuePanel({ assetId, data, canManage }: { assetId: string; data: GuidePanelData; canManage: boolean }) {
  const { latest, advance, candidates } = data
  const snap = latest?.snapshot
  return (
    <DataPanel
      title="Guide value"
      description="From the lender's published valuation guides. A reference only: a lease purchase and a recovery sale still need an independent valuation."
      actions={snap?.simulated ? <StatusPill tone="warning">Simulated guide</StatusPill> : undefined}
      density="loose"
    >
      <div className="space-y-4">
        {snap && latest ? (
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Item label="Guide">{snap.guideName} · effective {formatIsoDate(snap.effectiveOn)}</Item>
            <Item label="Row">{snap.make} {snap.model} {snap.year} · {variantOf(snap.variant)}</Item>
            <Item label="Trade value">{formatMoney(snap.tradeCents)}</Item>
            <Item label="Retail value">{formatMoney(snap.retailCents)}</Item>
            <Item label="Recorded">{formatIsoDate(latest.valuedOn)}</Item>
            {advance && (
              <>
                <Item label="Goods advance (cash price incl. VAT less deposit and trade-in)">{formatMoney(advance.cents)}</Item>
                <Item label="LTV against trade">{formatLtv(advance.tradeLtvBps)}</Item>
                <Item label="LTV against retail">{formatLtv(advance.retailLtvBps)}</Item>
              </>
            )}
          </dl>
        ) : (
          <p className="text-sm text-[var(--cf-text-muted)]">
            No guide value recorded.{advance ? ` Goods advance ${formatMoney(advance.cents)}.` : ""}
          </p>
        )}
        {candidates.length === 0 ? (
          <p className="text-sm text-[var(--cf-text-muted)]">
            No published guide has a row for this asset&apos;s make, model and year.{" "}
            <Link href="/asset-finance/valuation-guides" className="text-[var(--cf-brand)] hover:underline">Valuation guides</Link>
          </p>
        ) : canManage ? (
          <RecordGuideValueForm assetId={assetId} choices={candidates.map((c) => ({
            guideRowId: c.guideRowId,
            label: `${c.guideName} (${c.effectiveOn}${c.simulated ? ", simulated" : ""}) · ${variantOf(c.variant)} · trade ${formatMoney(c.tradeCents)} · retail ${formatMoney(c.retailCents)}`,
          }))} />
        ) : (
          <p className="text-sm text-[var(--cf-text-muted)]">{candidates.length} current guide row(s) match this asset.</p>
        )}
      </div>
    </DataPanel>
  )
}
