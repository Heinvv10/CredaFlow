import { prisma } from "@/lib/prisma"
import { isoOfDbDate } from "@/lib/asset-finance/dates"
import { NcaSurrenderControls } from "./NcaSurrenderControls"
export async function NcaSurrenderStaffPanel({ tenantId, loanId, canManage, canDecide, canRecordPayment }: { tenantId: string; loanId: string; canManage: boolean; canDecide: boolean; canRecordPayment: boolean }) {
  const loan = await prisma.loan.findFirst({ where: { id: loanId, tenantId, ncaRegime: "NCA", contractType: { not: "LOAN" } }, select: { id: true, status: true } })
  if (!loan) return null
  const [surrenders, account, recovery, instructions] = await Promise.all([
    prisma.surrenderRequest.findMany({ where: { tenantId, loanId }, orderBy: { createdAt: "desc" }, select: { id: true, status: true, valuationNoticeReceivedOn: true } }),
    prisma.ncaSurplusAccount.findFirst({ where: { tenantId, loanId }, select: { approvedById: true, releaseAuthorisedById: true } }),
    prisma.recovery.findFirst({ where: { tenantId, loanId, route: "NCA_S131_ATTACHMENT", status: { in: ["VALUATION_NOTICE_ISSUED", "LISTED", "SOLD", "PROCEEDS_APPLIED"] } }, select: { id: true, valuationNoticeReceivedOn: true } }),
    prisma.ncaSurplusRemittance.findMany({ where: { tenantId, OR: [{ surrender: { loanId } }, { recovery: { loanId } }] }, select: { id: true, status: true, amountCents: true, executedOn: true } }),
  ])
  return <NcaSurrenderControls canRequest={["ACTIVE", "DEFAULTED"].includes(loan.status)} instructions={instructions.map(i => ({ ...i, executedOn: i.executedOn ? isoOfDbDate(i.executedOn) : null }))} loanId={loanId} canManage={canManage} canDecide={canDecide} canRecordPayment={canRecordPayment}
    surrenders={surrenders.map((s) => ({ ...s, receivedOn: s.valuationNoticeReceivedOn ? isoOfDbDate(s.valuationNoticeReceivedOn) : null, valuationNoticeReceivedOn: undefined }))}
    accountStatus={!account ? "missing" : !account.approvedById ? "awaiting verification" : !account.releaseAuthorisedById ? "awaiting release authority" : "ready for remittance"}
    recovery={recovery ? { id: recovery.id, receivedOn: recovery.valuationNoticeReceivedOn ? isoOfDbDate(recovery.valuationNoticeReceivedOn) : null } : null} />
}
