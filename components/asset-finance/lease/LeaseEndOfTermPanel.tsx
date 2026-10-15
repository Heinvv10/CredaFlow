import { DataPanel } from "@/components/app-shell/DataPanel"
import { StatusPill } from "@/components/app-shell/StatusPill"
import { prisma } from "@/lib/prisma"
import { dbDate, fromDayNumber, isoOfDbDate, toDayNumber } from "@/lib/asset-finance/dates"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { canElect, nextEndStep, type EndStep } from "@/lib/asset-finance/lease-staff-actions"
import { ElectForm, InspectionForm, type ValuationChoice } from "./EndOfTermForms"
import { LeaseActionButton } from "./LeaseActionButton"
import type { LeaseStaffData } from "./lease-staff-data"

// A lease's end of term, status-driven: the election while it is open, then
// whichever single step applies (lib/asset-finance/lease-staff-actions.ts
// nextEndStep), shown only to a user whose permission it needs.

const OUTCOME_LABELS = { RETURN: "Return", EXTEND: "Extend month to month", PURCHASE: "Purchase" } as const
const STATUS_LABELS = {
  ELECTED: "Elected", EXTENDING: "Month to month", INSPECTED: "Inspected", INVOICED: "Invoiced: awaiting payment", COMPLETED: "Completed",
} as const
const STEP_LABELS: Record<EndStep, string> = {
  "extension-notice": "give notice to end the extension",
  inspection: "record the inspection",
  invoice: "issue the end-of-term invoice",
  "natis-confirmed": "confirm the eNaTIS change of ownership",
}
const link = "text-[var(--cf-brand)] underline-offset-2 hover:underline"

function Item({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-[var(--cf-text-muted)]">{label}</dt>
      <dd className="text-sm text-[var(--cf-text)]">{children}</dd>
    </div>
  )
}

async function recentValuations(tenantId: string, data: LeaseStaffData): Promise<ValuationChoice[]> {
  if (!data.assetId) return []
  const cutoff = fromDayNumber(toDayNumber(data.today) - data.purchaseMaxAgeDays)
  const rows = await prisma.assetValuation.findMany({
    where: { tenantId, assetId: data.assetId, valuedOn: { gte: dbDate(cutoff) } },
    orderBy: { valuedOn: "desc" },
    select: { id: true, valuedOn: true, valuerName: true, amountCents: true },
  })
  return rows.map((v) => ({
    id: v.id,
    label: `${formatIsoDate(isoOfDbDate(v.valuedOn))} · ${v.valuerName} · ${formatMoney(v.amountCents)}`,
    amountRands: (v.amountCents / 100).toFixed(2),
  }))
}

export async function LeaseEndOfTermPanel({ tenantId, data, canManage, canDecide }: { tenantId: string; data: LeaseStaffData; canManage: boolean; canDecide: boolean }) {
  const eot = data.endOfTerm
  const base = `/api/asset-finance/leases/${data.loanId}/end-of-term`
  const documents = `/api/asset-finance/leases/${data.loanId}/documents`
  const windowOpen = data.today >= data.electionOpensOn
  const elect = canElect({ loanStatus: data.loanStatus, hasEndOfTerm: eot !== null, windowOpen, canManage })
  const next = eot ? nextEndStep(eot, data.today) : null
  const allowed = next !== null && (next.needs === "manage" ? canManage : canDecide)
  const valuations = elect ? await recentValuations(tenantId, data) : []
  const unit = data.deal.usage ? (data.deal.usage.unit === "HOURS" ? "hours" : "km") : null

  return (
    <DataPanel
      title="End of term"
      description={`The fixed term ends ${formatIsoDate(data.expiryDate)}. The choice opens ${formatIsoDate(data.electionOpensOn)}, six months before the last rental.`}
      actions={eot && <StatusPill tone={eot.status === "COMPLETED" ? "success" : "info"}>{STATUS_LABELS[eot.status]}</StatusPill>}
      density="loose"
    >
      <div className="space-y-5">
        {!eot && !elect && (
          <p className="text-sm text-[var(--cf-text-muted)]">
            {!windowOpen ? `No end-of-term choice has been made. It opens on ${formatIsoDate(data.electionOpensOn)}.` : "No end-of-term choice has been made."}
          </p>
        )}
        {elect && <ElectForm url={`${base}/elect`} valuations={valuations} maxAgeDays={data.purchaseMaxAgeDays} />}

        {eot && (
          <dl className="grid grid-cols-2 gap-4 md:grid-cols-4">
            <Item label="Outcome">{OUTCOME_LABELS[eot.outcome]}</Item>
            <Item label="Chosen">{formatIsoDate(eot.electedOn)}{eot.origin === "EARLY_TERMINATION" && " (early termination)"}</Item>
            {eot.extensionNoticeOn && <Item label="Extension notice">{formatIsoDate(eot.extensionNoticeOn)}</Item>}
            {eot.extensionEndsOn && <Item label="Extension ends">{formatIsoDate(eot.extensionEndsOn)}</Item>}
            {eot.inspectedOn && <Item label="Inspected">{formatIsoDate(eot.inspectedOn)}</Item>}
            {eot.condition && <Item label="Condition">{eot.condition}</Item>}
            {eot.finalReading !== null && <Item label="Final reading">{eot.finalReading.toLocaleString("en-ZA")}{unit && ` ${unit}`}</Item>}
            {eot.purchasePriceExclVatCents !== null && <Item label="Purchase price ex VAT">{formatMoney(eot.purchasePriceExclVatCents)}</Item>}
            {eot.excessUsageCents !== null && <Item label="Excess usage ex VAT">{formatMoney(eot.excessUsageCents)}</Item>}
            {eot.fundSettlementCents !== null && eot.fundSettlementCents > 0 && <Item label="Fund deficit billed ex VAT">{formatMoney(eot.fundSettlementCents)}</Item>}
            {eot.invoice && (
              <Item label="Invoice">
                <a className={link} href={`/api/asset-finance/tax-invoices/${eot.invoice.id}`} target="_blank" rel="noopener noreferrer">{eot.invoice.number}</a>
                {" · "}
                <a className={link} href={`/api/asset-finance/tax-invoices/${eot.invoice.id}?download=1`}>Download</a>
              </Item>
            )}
            {eot.outcome === "PURCHASE" && eot.natisRequired && <Item label="eNaTIS change of ownership">{eot.natisConfirmed ? "Confirmed" : "Not yet confirmed"}</Item>}
            {eot.completedOn && <Item label="Completed">{formatIsoDate(eot.completedOn)}</Item>}
          </dl>
        )}
        {eot && eot.damage.length > 0 && (
          <ul className="list-disc space-y-1 pl-5 text-sm text-[var(--cf-text)]">
            {eot.damage.map((d) => <li key={d.id}>{d.description}: {formatMoney(d.amountExclVatCents)} ex VAT</li>)}
          </ul>
        )}

        {next && allowed && next.step === "inspection" && <InspectionForm url={`${base}/inspection`} today={data.today} usageUnitLabel={unit} />}
        {next && allowed && next.step === "extension-notice" && (
          <LeaseActionButton url={`${base}/extension-notice`} label="Give notice to end the extension" busyLabel="Recording…" variant="outline" />
        )}
        {next && allowed && next.step === "invoice" && (
          <LeaseActionButton url={`${base}/invoice`} label={eot?.outcome === "PURCHASE" ? "Issue the sale invoice" : "Issue the end-of-term invoice"} busyLabel="Invoicing…" />
        )}
        {next && allowed && next.step === "natis-confirmed" && (
          <LeaseActionButton url={`${base}/natis-confirmed`} label="Confirm the eNaTIS change of ownership" busyLabel="Confirming…" />
        )}
        {next && !allowed && (
          <p className="text-sm text-[var(--cf-text-muted)]">
            Next: {STEP_LABELS[next.step]}. This needs the {next.needs === "manage" ? "manage" : "decide"} asset finance permission.
          </p>
        )}
        {eot && !next && eot.status === "EXTENDING" && (
          <p className="text-sm text-[var(--cf-text-muted)]">
            The lease runs month to month: each month a rental is added until notice ends it{eot.extensionEndsOn && `; it ends ${formatIsoDate(eot.extensionEndsOn)}, then the asset is returned`}.
          </p>
        )}
        {(data.expiryNotice || eot?.inspectedOn) && (
          <p className="text-sm text-[var(--cf-text)]">
            {data.expiryNotice && (
              <a className={link} href={`${documents}/expiry-notice`} target="_blank" rel="noopener noreferrer">
                CPA expiry notice ({formatIsoDate(data.expiryNotice.queuedOn)})
              </a>
            )}
            {data.expiryNotice && eot?.inspectedOn && " · "}
            {eot?.inspectedOn && <a className={link} href={`${documents}/inspection-report`} target="_blank" rel="noopener noreferrer">Inspection report</a>}
          </p>
        )}
        {eot && !next && eot.status === "INVOICED" && (
          <p className="text-sm text-[var(--cf-text-muted)]">The end-of-term charge is on the rentals: the lease completes when it is paid{eot.natisRequired && !eot.natisConfirmed ? " and the eNaTIS change is confirmed" : ""}.</p>
        )}
      </div>
    </DataPanel>
  )
}
