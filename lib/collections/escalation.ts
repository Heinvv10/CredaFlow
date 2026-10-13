/**
 * Arrears Auto-Escalation — processes overdue loans through escalation stages
 */

import { prisma } from "@/lib/prisma"
import { triggerNotification } from "@/lib/notifications"
import { reverseReferralCommissionForLoan } from "@/lib/referral-agents/commission"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { chargesOutstandingAt } from "@/lib/loan/charges-replay"

interface EscalationResult {
  processed: number
  errors: number
  details: string[]
}

interface EscalationRule {
  minDays: number
  noteType: string
  action: (ctx: EscalationContext) => Promise<string>
}

interface EscalationContext {
  loanId: string
  loanRef: string
  tenantId: string
  clientId: string
  daysInArrears: number
  arrearsAmount: number
  outstandingPrincipal: number
  status: string
  ncaRegime: "NCA" | "NON_NCA"
}

async function noteExists(loanId: string, noteType: string, tenantId: string): Promise<boolean> {
  const existing = await prisma.loanNote.findFirst({
    where: { loanId, type: noteType, tenantId },
  })
  return !!existing
}

async function createNote(loanId: string, type: string, note: string, tenantId: string): Promise<void> {
  await prisma.loanNote.create({
    data: { tenantId, loanId, type, note, createdBy: "system" },
  })
}

const RULES: EscalationRule[] = [
  {
    minDays: 5,
    noteType: "escalation_soft",
    action: async (ctx) => {
      await createNote(ctx.loanId, "escalation_soft", "Account moved to collections queue — 5 days overdue", ctx.tenantId)
      return `${ctx.loanRef}: soft escalation at ${ctx.daysInArrears} DPD`
    },
  },
  {
    minDays: 60,
    noteType: "escalation_default",
    action: async (ctx) => {
      // The borrower is quoted arrears + default charges outstanding (0 while
      // the flag is off). ctx.arrearsAmount itself stays schedule-only: the
      // Section 129 eligibility gate reads it. Read before any write, so a
      // failure leaves the rule to retry on the next run.
      const charges = await chargesOutstandingAt(prisma, { tenantId: ctx.tenantId, loanId: ctx.loanId }, new Date())
      await prisma.loan.updateMany({
        where: { id: ctx.loanId, tenantId: ctx.tenantId },
        data: { status: "DEFAULTED" },
      })
      await reverseReferralCommissionForLoan(prisma, { tenantId: ctx.tenantId, loanId: ctx.loanId })
      await createNote(
        ctx.loanId,
        "escalation_default",
        "Loan status changed to DEFAULTED — 60 days overdue",
        ctx.tenantId
      )
      triggerNotification({
        tenantId: ctx.tenantId,
        event: "loan_overdue",
        loanId: ctx.loanId,
        clientId: ctx.clientId,
        data: { daysOverdue: ctx.daysInArrears, amount: ctx.arrearsAmount + charges, escalation: "defaulted" },
      }).catch(() => {})
      return `${ctx.loanRef}: marked DEFAULTED at ${ctx.daysInArrears} DPD`
    },
  },
  {
    minDays: 90,
    noteType: "escalation_legal",
    action: async (ctx) => {
      const eligibility = evaluateCollectionsEligibility(ctx, "SECTION_129")
      if (!eligibility.eligible) {
        throw new Error(`Section 129 legal review not created: ${eligibility.reason}`)
      }
      await createNote(
        ctx.loanId,
        "escalation_legal",
        "Account is eligible for Section 129 legal review at 90+ days overdue. Manual guarded issuance is required; no notice was auto-sent.",
        ctx.tenantId
      )
      return `${ctx.loanRef}: flagged for Section 129 legal review at ${ctx.daysInArrears} DPD; no notice auto-sent`
    },
  },
]

export async function processEscalations(): Promise<EscalationResult> {
  const result: EscalationResult = { processed: 0, errors: 0, details: [] }

  const tenant = await prisma.tenant.findFirst({
    where: { status: "ACTIVE" },
    select: { id: true },
  })
  if (!tenant) {
    result.details.push("No active tenant found")
    return result
  }

  const loans = await prisma.loan.findMany({
    where: {
      tenantId: tenant.id,
      status: { in: ["ACTIVE", "DEFAULTED"] },
      daysInArrears: { gte: 5 },
      // Never auto-escalate / auto-S.129 a settled R0 account.
      arrearsAmount: { gt: 0 },
      outstandingPrincipal: { gt: 0 },
    },
    select: {
      id: true,
      reference: true,
      clientId: true,
      daysInArrears: true,
      arrearsAmount: true,
      outstandingPrincipal: true,
      status: true,
      ncaRegime: true,
    },
  })

  for (const loan of loans) {
    // The escalation ladder (reminders, s129, handover) is the consumer NCA
    // process; an entity borrower (asset finance) is not escalated here.
    const clientId = loan.clientId
    if (clientId === null) continue
    for (const rule of RULES) {
      if (loan.daysInArrears < rule.minDays) continue

      const exists = await noteExists(loan.id, rule.noteType, tenant.id)
      if (exists) continue

      const ctx: EscalationContext = {
        loanId: loan.id,
        loanRef: loan.reference,
        tenantId: tenant.id,
        clientId,
        daysInArrears: loan.daysInArrears,
        arrearsAmount: loan.arrearsAmount,
        outstandingPrincipal: loan.outstandingPrincipal,
        status: loan.status,
        ncaRegime: loan.ncaRegime,
      }

      try {
        const detail = await rule.action(ctx)
        result.processed++
        result.details.push(detail)
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error"
        result.details.push(`Error ${loan.reference} ${rule.noteType}: ${msg}`)
        // This is a Section 129 legal notice / DEFAULTED status / commission
        // clawback pipeline (see the module doc). A rule that keeps throwing
        // was previously invisible: no counter, no ok field, and the loan's
        // escalation simply never advances. Count it so the cron can report
        // the run as failed.
        result.errors++
      }
    }
  }

  return result
}
