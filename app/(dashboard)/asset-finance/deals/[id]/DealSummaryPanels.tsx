import Link from "next/link"
import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { formatDate, formatZAR } from "@/lib/utils"
import type { DealDetail } from "@/lib/asset-finance/deal-detail"
import { PRESET_LABELS, RATE_BASIS_LABELS, ratePercent } from "@/lib/asset-finance/deal-labels"
import { ENTITY_ROLE_LABELS, statusLabel } from "@/lib/asset-finance/labels"

// Read-only panels of the staff deal page. No hooks: server-rendered.

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="text-sm text-[var(--cf-text)]">{children}</dd>
    </div>
  )
}

export function DealSummaryPanel({ deal }: { deal: DealDetail }) {
  const { terms } = deal
  const rate = terms.rate.basis === "FIXED"
    ? `Fixed ${ratePercent(terms.rate.fixedRate ?? "0")}`
    : `${RATE_BASIS_LABELS[terms.rate.basis]} ${terms.rate.margin?.startsWith("-") ? "−" : "+"} ${ratePercent((terms.rate.margin ?? "0").replace("-", ""))}`
  return (
    <DataPanel title="Deal" density="loose">
      <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Item label="Borrower">
          <Link href={`/asset-finance/entities/${deal.entity.id}`} className="text-[var(--cf-brand)] hover:underline">{deal.entity.legalName}</Link>
        </Item>
        <Item label="Asset">
          <Link href={`/asset-finance/assets/${deal.asset.id}`} className="text-[var(--cf-brand)] hover:underline">{deal.asset.description}</Link>
          <span className="block font-mono text-xs text-[var(--cf-text-muted)]">{deal.asset.serialNumber}</span>
        </Item>
        <Item label="Supplier">{deal.supplier.name}</Item>
        <Item label="Product">{deal.product.name}</Item>
        <Item label="Cash price incl. VAT">{formatZAR(deal.asset.cashPriceExclVatCents + deal.asset.vatCents)}</Item>
        <Item label="Deposit / trade-in">{formatZAR(terms.depositCents)} / {formatZAR(terms.tradeInCents)}</Item>
        <Item label="Financed fees / balloon">{formatZAR(terms.financedFeesCents)} / {formatZAR(terms.balloonCents)}</Item>
        <Item label="Financed amount">{formatZAR(deal.application.appliedAmount)}</Item>
        <Item label="Rate">{rate}</Item>
        <Item label="Structure">{PRESET_LABELS[terms.preset]} · {terms.weights.length} months</Item>
        <Item label="First due">{terms.firstDueDate}</Item>
        <Item label="Application">{deal.application.reference} · {statusLabel(deal.application.status)}</Item>
      </dl>
    </DataPanel>
  )
}

export function ClassificationPanel({ deal, children }: { deal: DealDetail; children?: React.ReactNode }) {
  const { application: app } = deal
  return (
    <DataPanel title="NCA classification" density="loose">
      <div className="space-y-3 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          {app.ncaRegime === null ? (
            <StatusPill>Not classified — submit the deal</StatusPill>
          ) : (
            <StatusPill tone={app.ncaRegime === "NON_NCA" ? "success" : "warning"}>{app.ncaRegime}</StatusPill>
          )}
          {app.ncaClassificationRule && <span className="font-mono text-xs text-[var(--cf-text-secondary)]">{app.ncaClassificationRule}</span>}
          {deal.awaitingRegimeApproval && <StatusPill tone="info">NON_NCA override awaits a second approver</StatusPill>}
        </div>
        {app.decisionReason && deal.status === "REFUSED_NCA" && (
          <p className="text-[var(--cf-danger)]">{app.decisionReason}</p>
        )}
        <p className="text-xs text-[var(--cf-text-muted)]">
          Slice 1 finances non-NCA deals only. Sureties: {deal.sureties.length === 0 ? "none on the entity" : deal.sureties.map((s) => s.name).join(", ")}
          {" "}(the entity&apos;s active SURETY relationships).
        </p>
        {children}
      </div>
    </DataPanel>
  )
}

export function BureauTable({ deal }: { deal: DealDetail }) {
  if (deal.bureau.length === 0) {
    return <p className="text-sm text-[var(--cf-text-muted)]">No bureau checks yet. Directors and trustees: {deal.directorsAndTrustees.map((p) => `${p.name} (${ENTITY_ROLE_LABELS[p.role as keyof typeof ENTITY_ROLE_LABELS]})`).join(", ") || "none on the entity"}.</p>
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Person</TableHead>
          <TableHead>Outcome</TableHead>
          <TableHead className="text-right">Score</TableHead>
          <TableHead>Grade</TableHead>
          <TableHead>Flags</TableHead>
          <TableHead>When</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {deal.bureau.map((b, i) => (
          <TableRow key={`${b.clientId}-${b.at}-${i}`}>
            <TableCell>{b.name}</TableCell>
            <TableCell>
              <StatusPill tone={b.outcome === "stored" ? "success" : b.outcome === "skipped" ? "warning" : "danger"}>{b.outcome}</StatusPill>
              {b.detail && <span className="ml-2 text-xs text-[var(--cf-text-muted)]">{b.detail}</span>}
            </TableCell>
            <TableCell className="text-right">{b.score ?? "—"}</TableCell>
            <TableCell>{b.riskGrade ?? "—"}</TableCell>
            <TableCell className="text-xs">
              {[b.hasAdverse && "adverse", b.hasJudgement && "judgement", b.underDebtReview && "debt review", b.deceased && "deceased"]
                .filter(Boolean).join(", ") || "none"}
            </TableCell>
            <TableCell>{formatDate(b.at)}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
