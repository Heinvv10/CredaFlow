import type { RecoveryRoute } from "@prisma/client"
import { prisma } from "@/lib/prisma"
import { effectiveSteps } from "@/lib/asset-finance/legal-matter-hint"
import { getLegalMatterView } from "@/lib/asset-finance/legal-matter-view"
import { loadStaffRecoveryView } from "@/lib/asset-finance/recovery-view"
import { formatIsoDate, formatMoney } from "@/lib/asset-finance/format"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { isLeaseContract } from "@/lib/asset-finance/lease-input"
import type { ChoiceOption } from "./legal-fields"
import { STEP_LABELS } from "./legal-matter-form"
import { VALUATION_SOURCE_LABELS, type CostAllowLists } from "./recovery-model"
import type { ValuationOption } from "./ProposeSaleForm"
import type { SurrenderLink } from "./ValuationForm"

export type StaffRecovery = NonNullable<Awaited<ReturnType<typeof loadStaffRecoveryView>>>

export interface WithdrawnRecovery { id: string; route: RecoveryRoute; recoveredOn: string; reason: string }

export type RecoveryPanelData =
  | { kind: "none" }
  /** No live recovery: `canRecord` says whether one can be recorded (an NCA loan needs a surrender without a recovery), `withdrawn` is the history. */
  | { kind: "record"; regime: "NCA" | "NON_NCA"; lease: boolean; surrenders: ChoiceOption[]; canRecord: boolean; withdrawn: WithdrawnRecovery[] }
  | { kind: "recovery"; view: StaffRecovery; regime: "NCA" | "NON_NCA"; lease: boolean; surrender: (SurrenderLink & { status: string }) | null }

/**
 * The loan's current recovery (its open one, else the latest that is not
 * withdrawn), or what can start one. A withdrawn recovery is history: the
 * record form returns beside it. `bankDetails` (manage_asset_finance) lets the
 * refund carry its account for the people who approve it. Everything is tenant-scoped.
 */
export async function loadRecoveryPanelData(tenantId: string, loanId: string, opts: { bankDetails?: boolean } = {}): Promise<RecoveryPanelData> {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId, contractType: { not: "LOAN" } }, select: { ncaRegime: true, contractType: true } })
  if (!loan) return { kind: "none" }
  const regime = loan.ncaRegime === "NCA" ? "NCA" : "NON_NCA"
  const lease = isLeaseContract(loan.contractType)
  const current = await prisma.recovery.findFirst({
    where: { tenantId, loanId, status: { notIn: ["CLOSED", "WITHDRAWN"] } }, select: { id: true },
  }) ?? await prisma.recovery.findFirst({ where: { tenantId, loanId, status: { not: "WITHDRAWN" } }, orderBy: { createdAt: "desc" }, select: { id: true } })
  const view = current ? await loadStaffRecoveryView(tenantId, current.id, { bankDetails: opts.bankDetails ?? false }) : null
  if (view) {
    const surrender = view.surrenderRequestId
      ? await prisma.surrenderRequest.findFirst({ where: { id: view.surrenderRequestId, tenantId }, select: { id: true, status: true, valuationId: true } })
      : null
    return { kind: "recovery", view, regime, lease, surrender: surrender ? { id: surrender.id, status: surrender.status, hasValuation: surrender.valuationId !== null } : null }
  }
  const withdrawn = (await prisma.recovery.findMany({
    where: { tenantId, loanId, status: "WITHDRAWN" }, orderBy: { createdAt: "desc" }, take: 5, select: { id: true, route: true, recoveredOn: true, withdrawnReason: true },
  })).map((r) => ({ id: r.id, route: r.route, recoveredOn: isoOfDbDate(r.recoveredOn), reason: r.withdrawnReason ?? "" }))
  const surrenders = regime === "NCA"
    ? await prisma.surrenderRequest.findMany({ where: { tenantId, loanId, recovery: null }, orderBy: { createdAt: "desc" }, select: { id: true, requestedOn: true } })
    : []
  const canRecord = regime === "NON_NCA" || surrenders.length > 0
  if (!canRecord && withdrawn.length === 0) return { kind: "none" }
  return {
    kind: "record", regime, lease, canRecord, withdrawn,
    surrenders: surrenders.map((s) => ({ value: s.id, label: `Surrender requested ${formatIsoDate(isoOfDbDate(s.requestedOn))}` })),
  }
}

export interface CostFormData { lists: CostAllowLists; suppliers: ChoiceOption[]; legalSteps: ChoiceOption[] }

/** What the add-cost form offers: the lender's allow-lists, suppliers, and the judgment or settlement steps (with their legal document) a taxed legal cost follows. */
export async function loadCostFormData(tenantId: string, loanId: string): Promise<CostFormData> {
  const [config, suppliers, matter] = await Promise.all([
    prisma.tenantConfig.findFirst({ where: { tenantId }, select: { recoveryNcaDeductibleCostTypes: true, recoveryNonNcaChargeableCostTypes: true } }),
    prisma.supplier.findMany({ where: { tenantId, active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    getLegalMatterView(tenantId, { loanId }),
  ])
  const effective = matter.kind === "done" && matter.view ? new Set(effectiveSteps(matter.view.steps).map((s) => s.id)) : new Set<string>()
  const steps = matter.kind === "done" && matter.view
    ? matter.view.steps.filter((s) => effective.has(s.id) && (s.kind === "JUDGMENT" || s.kind === "SETTLED") && s.hasEvidence)
    : []
  return {
    lists: { ncaDeductible: config?.recoveryNcaDeductibleCostTypes ?? [], nonNcaChargeable: config?.recoveryNonNcaChargeableCostTypes ?? [] },
    suppliers: suppliers.map((s) => ({ value: s.id, label: s.name })),
    legalSteps: steps.map((s) => ({ value: s.id, label: `${STEP_LABELS[s.kind]} · ${formatIsoDate(s.stepDate)}` })),
  }
}

/** The independent valuations of the asset a sale can rely on (any source but internal; the server checks their age), newest first. */
export async function loadSaleValuations(tenantId: string, assetId: string): Promise<ValuationOption[]> {
  const rows = await prisma.assetValuation.findMany({
    where: { tenantId, assetId, source: { not: "INTERNAL" } }, orderBy: { valuedOn: "desc" }, take: 10, select: { id: true, valuedOn: true, source: true, amountCents: true },
  })
  return rows.map((v) => ({ value: v.id, amountCents: v.amountCents, label: `${formatMoney(v.amountCents)} · ${VALUATION_SOURCE_LABELS[v.source]}, ${formatIsoDate(isoOfDbDate(v.valuedOn))}` }))
}
