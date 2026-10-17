import { NcaSurrenderStaffPanel } from "../NcaSurrenderStaffPanel"
import { LegalMatterPanel } from "./LegalMatterPanel"
import { RecoveryPanel } from "./RecoveryPanel"

/** Court action and recovery belong to a loan on an asset (any contract type but a plain loan), whoever the borrower is. */
export const hasRecoveryPanels = (loan: { contractType: string; assetId?: string | null; asset?: unknown }): boolean =>
  loan.contractType !== "LOAN" && Boolean(loan.assetId ?? loan.asset)

/**
 * The Legal matter and Recovery panels of a staff loan page, shared by the
 * entity/lease view and the consumer view (a sole proprietor's instalment
 * sale is a client's loan). `canManage` / `canDecide` / `canRecordPayment` are
 * manage_asset_finance / decide_asset_finance / record_payment.
 */
export function AssetLoanRecoveryPanels({ tenantId, loanId, userId, canManage, canDecide, canRecordPayment }: {
  tenantId: string
  loanId: string
  userId: string
  canManage: boolean
  canDecide: boolean
  canRecordPayment: boolean
}) {
  return (
    <>
      <NcaSurrenderStaffPanel tenantId={tenantId} loanId={loanId} canManage={canManage} canDecide={canDecide} canRecordPayment={canRecordPayment} />
      <LegalMatterPanel tenantId={tenantId} loanId={loanId} canManage={canManage} />
      <RecoveryPanel tenantId={tenantId} loanId={loanId} userId={userId} canManage={canManage} canDecide={canDecide} canRecordPayment={canRecordPayment} />
    </>
  )
}
