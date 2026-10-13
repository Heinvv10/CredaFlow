import Link from "next/link"
import { Pencil } from "lucide-react"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { Button } from "@/components/ui/button"
import { formatDate } from "@/lib/utils"
import { formatMoney } from "@/lib/asset-finance/format"
import { ENTITY_TYPE_LABELS } from "@/lib/asset-finance/labels"
import type { EntityCore } from "@/lib/asset-finance/entity-detail"

function Row({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs font-semibold uppercase tracking-wide text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="mt-0.5 text-sm text-[var(--cf-text)]">{value ?? "—"}</dd>
    </div>
  )
}

export function EntityDetailsPanel({ entity, canManage }: { entity: EntityCore; canManage: boolean }) {
  const address = [entity.addressLine1, entity.addressLine2, entity.city, entity.province, entity.postalCode]
    .filter(Boolean)
    .join(", ")
  const actions = canManage ? (
    <Button asChild size="sm" variant="outline">
      <Link href={`/asset-finance/entities/${entity.id}/edit`}>
        <Pencil className="h-3.5 w-3.5" />
        Edit
      </Link>
    </Button>
  ) : null
  return (
    <DataPanel title="Details" actions={actions}>
      <dl className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Row label="Type" value={ENTITY_TYPE_LABELS[entity.type]} />
        <Row label="Registration number" value={entity.registrationNumber} />
        {entity.type === "TRUST" && <Row label="Master's reference" value={entity.mastersReference} />}
        <Row label="Trading name" value={entity.tradingName} />
        <Row label="VAT number" value={entity.vatNumber} />
        <Row label="Annual turnover" value={entity.annualTurnover === null ? null : formatMoney(entity.annualTurnover)} />
        <Row label="Total asset value" value={entity.totalAssetValue === null ? null : formatMoney(entity.totalAssetValue)} />
        <Row label="Financial year end" value={entity.financialYearEnd ? formatDate(entity.financialYearEnd) : null} />
        <Row
          label="Financials evidence"
          value={entity.financialsEvidenceIds.length === 0 ? "None attached" : `${entity.financialsEvidenceIds.length} verified document(s)`}
        />
        <Row label="Address" value={address || null} />
      </dl>
    </DataPanel>
  )
}
