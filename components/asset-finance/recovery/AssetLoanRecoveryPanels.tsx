import { canDo } from "@/lib/auth-guards"
import type { AppRole } from "@/lib/auth-config"
import { NcaSurrenderStaffPanel } from "../NcaSurrenderStaffPanel"
import { TelematicsPanel } from "../telematics/TelematicsPanel"
import { CommercialCancellationPanel } from "./CommercialCancellationPanel"
import { LegalMatterPanel } from "./LegalMatterPanel"
import { RecoveryPanel } from "./RecoveryPanel"

/** Court action and recovery belong to a loan on an asset (any contract type but a plain loan), whoever the borrower is. */
export const hasRecoveryPanels = (loan: { contractType: string; assetId?: string | null; asset?: unknown }): boolean =>
  loan.contractType !== "LOAN" && Boolean(loan.assetId ?? loan.asset)

/**
 * The Legal matter and Recovery panels of a staff loan page, shared by the
 * entity/lease view and the consumer view (a sole proprietor's instalment
 * sale is a client's loan). `canManage` / `canDecide` / `canRecordPayment` are
 * manage_asset_finance / decide_asset_finance / record_payment; `role` decides
 * the tracker panel's alerts (work_telematics_alerts) and the logged "Show last
 * known position" (view_asset_position), never shown to READONLY.
 */
export function AssetLoanRecoveryPanels({ tenantId, loanId, userId, canManage, canDecide, canRecordPayment, role }: {
  tenantId: string
  loanId: string
  userId: string
  canManage: boolean
  canDecide: boolean
  canRecordPayment: boolean
  role?: string | null
}) {
  const canViewPosition = role ? canDo(role as AppRole, "view_asset_position") : false
  return (
    <>
      <TelematicsPanel tenantId={tenantId} loanId={loanId} viewerId={userId} canManage={canManage} canWork={role ? canDo(role as AppRole, "work_telematics_alerts") : false} canViewPosition={canViewPosition} />
      <NcaSurrenderStaffPanel tenantId={tenantId} loanId={loanId} canManage={canManage} canDecide={canDecide} canRecordPayment={canRecordPayment} />
      <CommercialCancellationPanel tenantId={tenantId} loanId={loanId} canDecide={canDecide} />
      <LegalMatterPanel tenantId={tenantId} loanId={loanId} canManage={canManage} canViewPosition={canViewPosition} />
      <RecoveryPanel tenantId={tenantId} loanId={loanId} userId={userId} canManage={canManage} canDecide={canDecide} canRecordPayment={canRecordPayment} canViewPosition={canViewPosition} />
    </>
  )
}
