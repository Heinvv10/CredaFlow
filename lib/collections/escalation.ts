/**
 * Arrears Auto-Escalation — processes overdue loans through escalation stages
 */

import { prisma } from "@/lib/prisma"
import { triggerNotification } from "@/lib/notifications"
import { reverseReferralCommissionForLoan } from "@/lib/referral-agents/commission"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { chargesOutstandingAt } from "@/lib/loan/charges-replay"
import { isLoanHeld, section129DebtReviewReason } from "@/lib/collections/client-holds"
import { sweepActiveTenants, tenantFailureDetail, type SweepTenant } from "@/lib/collections/tenant-sweep"

interface EscalationResult {
  processed: number
  errors: number
  details: string[]
}

interface EscalationRule {
  minDays: number
  noteType: string
  /** Absent: every loan. A rule outside a loan's regime is skipped, not counted as an error. */
  appliesTo?: (ctx: EscalationContext) => boolean
  action: (ctx: EscalationContext) => Promise<string>
}

interface EscalationContext {
  loanId: string
  loanRef: string
  tenantId: string
  /** null for an entity borrower (asset finance): there is no natural person to message. */
  clientId: string | null
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
      // The DEFAULTED flip above is business logic and always happens. The
      // borrower notification does not go to a held loan or client (attorney
      // referral, write-off, an arrangement or plan, a death, a debt-review
      // notice; lib/collections/dunning-holds.ts): skipped, and said so.
      if (await isLoanHeld({ tenantId: ctx.tenantId, loanId: ctx.loanId })) {
        console.warn(`[escalation] ${ctx.loanRef}: loan_overdue defaulted notice not sent, the loan or client is on a dunning hold`)
        return `${ctx.loanRef}: marked DEFAULTED at ${ctx.daysInArrears} DPD; borrower notification skipped (dunning hold)`
      }
      // A consumer is messaged as the borrower; an entity borrower (no
      // Client) through the people who act for it, in copy that names the
      // entity (triggerNotification → lib/asset-finance/entity-notifications.ts).
      triggerNotification({
        tenantId: ctx.tenantId,
        event: "loan_overdue",
        loanId: ctx.loanId,
        ...(ctx.clientId !== null ? { clientId: ctx.clientId } : {}),
        data: { daysOverdue: ctx.daysInArrears, amount: ctx.arrearsAmount + charges, escalation: "defaulted" },
      }).catch(() => {})
      return `${ctx.loanRef}: marked DEFAULTED at ${ctx.daysInArrears} DPD`
    },
  },
  {
    minDays: 90,
    noteType: "escalation_legal",
    // Section 129 is an NCA remedy: the regime decides, not the borrower type.
    appliesTo: (ctx) => ctx.ncaRegime === "NCA",
    action: async (ctx) => {
      const eligibility = evaluateCollectionsEligibility(ctx, "SECTION_129")
      if (!eligibility.eligible) {
        throw new Error(`Section 129 legal review not created: ${eligibility.reason}`)
      }
      // Debt review (NCA s.86) blocks Section 129 on every loan of the client: no
      // legal-review flag while it stands. No note is written, so the check runs
      // again on the next pass and the flag appears once the notice is cleared.
      const debtReview = ctx.clientId
        ? await section129DebtReviewReason(prisma, { tenantId: ctx.tenantId, clientId: ctx.clientId })
        : null
      if (debtReview) {
        return `${ctx.loanRef}: Section 129 legal review not flagged at ${ctx.daysInArrears} DPD: ${debtReview}`
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

/** Every ACTIVE tenant, each in its own frame (lib/collections/tenant-sweep.ts). */
export async function processEscalations(): Promise<EscalationResult> {
  const total: EscalationResult = { processed: 0, errors: 0, details: [] }
  const outcomes = await sweepActiveTenants("escalations", (tenant) => processTenantEscalations(tenant))
  if (outcomes.length === 0) total.details.push("No active tenant found")
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      total.errors++
      total.details.push(tenantFailureDetail(outcome.tenant, outcome.error))
      continue
    }
    total.processed += outcome.value.processed
    total.errors += outcome.value.errors
    total.details.push(...outcome.value.details)
  }
  return total
}

async function processTenantEscalations(tenant: SweepTenant): Promise<EscalationResult> {
  const result: EscalationResult = { processed: 0, errors: 0, details: [] }

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
    for (const rule of RULES) {
      if (loan.daysInArrears < rule.minDays) continue

      const exists = await noteExists(loan.id, rule.noteType, tenant.id)
      if (exists) continue

      const ctx: EscalationContext = {
        loanId: loan.id,
        loanRef: loan.reference,
        tenantId: tenant.id,
        clientId: loan.clientId,
        daysInArrears: loan.daysInArrears,
        arrearsAmount: loan.arrearsAmount,
        outstandingPrincipal: loan.outstandingPrincipal,
        status: loan.status,
        ncaRegime: loan.ncaRegime,
      }
      if (rule.appliesTo && !rule.appliesTo(ctx)) continue

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
