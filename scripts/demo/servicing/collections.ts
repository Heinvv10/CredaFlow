/**
 * Collections actions, through the calls the collections screens make:
 *
 *   stage         CollectionsStagePanel → PATCH /api/loans/[id]/collections-stage
 *                 (SOFT/FORMAL reminder only; later stages have their own actions)
 *   Section 129   Section129Button → POST /api/loans/section129 (needs 90 DPD and
 *                 an email provider that accepts the notice)
 *   arrangement   ArrangementForm → POST /api/loans/[id]/payment-arrangement
 *   payment plan  PaymentPlanButton → POST /api/loans/[id]/payment-plan (rands)
 *   attorney      AttorneyReferralForm → POST /api/loans/[id]/attorney-referral
 *                 (needs an issued Section 129 notice)
 *   write-off     WriteOffForm (request) and WriteOffApprovalCard (approve),
 *                 PATCH /api/loans/[id]/write-off — dual control, two LOAN_ADMINs
 */
import type { SimClient } from "../sim/api"
import { now } from "../sim/clock"
import { log } from "../sim/env"
import { ATTORNEY_FIRM } from "./setup"

export async function moveStage(actor: SimClient, loanId: string, stage: "SOFT_REMINDER" | "FORMAL_REMINDER", notes: string): Promise<void> {
  await actor.patch(`/api/loans/${loanId}/collections-stage`, { stage, notes }, { expect: [200] })
  log(`loan ${loanId}: collections stage → ${stage}`)
}

interface S129Response {
  ok?: boolean
  error?: string
  dispatchState?: string
  issuanceId?: string
}

export async function issueSection129(actor: SimClient, loanId: string): Promise<void> {
  const res = await actor.post<S129Response>("/api/loans/section129", { loanId }, { expect: [200] })
  if (res.json?.ok !== true) throw new Error(`Section 129 not issued: ${res.text.slice(0, 400)}`)
  log(`loan ${loanId}: Section 129 notice issued`)
}

export interface ArrangementInput {
  agreedAmountCents: number
  /** YYYY-MM-DD of the first and last agreed payment. */
  startDay: string
  endDay: string
  notes: string
}

export async function createArrangement(actor: SimClient, loanId: string, a: ArrangementInput): Promise<void> {
  await actor.post(`/api/loans/${loanId}/payment-arrangement`, {
    arrangementDate: now().toISOString(),
    agreedAmount: a.agreedAmountCents,
    frequency: "MONTHLY",
    startDate: a.startDay,
    endDate: a.endDay,
    notes: a.notes,
  }, { expect: [200] })
  log(`loan ${loanId}: payment arrangement R${a.agreedAmountCents / 100}/month ${a.startDay}…${a.endDay}`)
}

export async function createPaymentPlan(
  actor: SimClient,
  loanId: string,
  arrearsCents: number,
  installments: number,
  startDay: string,
  notes: string,
): Promise<void> {
  const totalArrears = arrearsCents / 100
  await actor.post(`/api/loans/${loanId}/payment-plan`, {
    totalArrears,
    installments,
    installmentAmt: totalArrears / installments,
    startDate: startDay,
    notes,
  }, { expect: [201] })
  log(`loan ${loanId}: arrears payment plan ${installments} × R${(totalArrears / installments).toFixed(2)}`)
}

export async function referToAttorney(actor: SimClient, loanId: string, matterNumber: string): Promise<void> {
  const firms = (await actor.get<Array<{ id: string; name: string; contactPerson: string | null; phone: string | null; email: string | null }>>("/api/settings/attorneys")).json ?? []
  const firm = firms.find((f) => f.name === ATTORNEY_FIRM)
  if (!firm) throw new Error(`attorney firm ${ATTORNEY_FIRM} is not registered`)
  await actor.post(`/api/loans/${loanId}/attorney-referral`, {
    firmId: firm.id,
    firmName: firm.name,
    contactPerson: firm.contactPerson ?? undefined,
    contactPhone: firm.phone ?? undefined,
    contactEmail: firm.email ?? undefined,
    referralDate: now().toISOString(),
    matterNumber,
    notes: "Section 129 notice period lapsed without payment or response; handed over for pre-enforcement review.",
  }, { expect: [200] })
  log(`loan ${loanId}: referred to ${firm.name}`)
}

export async function requestWriteOff(actor: SimClient, loanId: string, reason: string): Promise<void> {
  await actor.patch(`/api/loans/${loanId}/write-off`, { action: "request", reason }, { expect: [200] })
  log(`loan ${loanId}: write-off requested`)
}

export async function approveWriteOff(actor: SimClient, loanId: string): Promise<void> {
  await actor.patch(`/api/loans/${loanId}/write-off`, { action: "approve", confirm: true }, { expect: [200] })
  log(`loan ${loanId}: write-off approved`)
}
