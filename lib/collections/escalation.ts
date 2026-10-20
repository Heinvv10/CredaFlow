/**
 * Arrears Auto-Escalation — processes overdue loans through escalation stages
 */

import { prisma } from "@/lib/prisma"
import { triggerNotification } from "@/lib/notifications"
import { reverseReferralCommissionForLoan } from "@/lib/referral-agents/commission"
import { evaluateCollectionsEligibility } from "@/lib/collections/section129-eligibility"
import { chargesOutstandingAt } from "@/lib/loan/charges-replay"
import { loanDunningHold, section129DebtReviewReason } from "@/lib/collections/client-holds"
import { NOTICE_LOAN_STATUSES } from "@/lib/collections/dunning-holds"
import { ensureDpdCurrent } from "@/lib/loan/dpd-update"
import { isDatabaseInfrastructureError } from "@/lib/ops/db-fault"
import { releaseReservation, reserveOnce } from "@/lib/ops/send-reservation"
import { sweepActiveTenants, tenantFailureDetail, type SweepTenant } from "@/lib/ops/tenant-sweep"

interface EscalationResult {
  processed: number
  /** includes each failed tenant */
  errors: number
  details: string[]
  /** ACTIVE tenants swept, and the ones whose run threw */
  tenants: number
  failedTenants: number
}

interface EscalationRule {
  minDays: number
  noteType: string
  /** Absent: every loan. A rule outside a loan's regime is skipped, not counted as an error. */
  appliesTo?: (ctx: EscalationContext) => boolean
  /** The detail line, or `{ settled }` when the loan no longer needs this rule or any later one (nothing was done). */
  action: (ctx: EscalationContext) => Promise<string | { settled: string }>
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

/**
 * The 60-DPD DEFAULTED notice goes only to a loan that crossed 60 days
 * recently. Anything older (the first run after this cron was scheduled finds
 * every loan already past 60) still gets its status flip and note, but not a
 * "you are now defaulted" notice that is weeks stale. The window tolerates a
 * few missed nights.
 */
export const DEFAULT_NOTICE_MAX_DPD = 66

/** The days in arrears at which a loan is defaulted. */
const DEFAULT_AT_DPD = 60

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
    minDays: DEFAULT_AT_DPD,
    noteType: "escalation_default",
    action: async (ctx) => {
      // The borrower is quoted arrears + default charges outstanding (0 while
      // the flag is off). ctx.arrearsAmount itself stays schedule-only: the
      // Section 129 eligibility gate reads it. Read before any write, so a
      // failure leaves the rule to retry on the next run.
      const charges = await chargesOutstandingAt(prisma, { tenantId: ctx.tenantId, loanId: ctx.loanId }, new Date())
      // Conditional, re-evaluated by the database at the moment of the write: the loan was read at the
      // start of the run, and one settled (COMPLETED) or brought out of arrears since must not be
      // defaulted, noted, have its commission clawed back or be sent the notice.
      const flipped = await prisma.loan.updateMany({
        where: {
          id: ctx.loanId,
          tenantId: ctx.tenantId,
          status: { in: [...NOTICE_LOAN_STATUSES] },
          daysInArrears: { gte: DEFAULT_AT_DPD },
          arrearsAmount: { gt: 0 },
          outstandingPrincipal: { gt: 0 },
        },
        data: { status: "DEFAULTED" },
      })
      if (flipped.count === 0) {
        return { settled: `${ctx.loanRef}: not defaulted, the loan is no longer ACTIVE, ${DEFAULT_AT_DPD}+ days in arrears and in arrears (settled or cleared since it was read)` }
      }
      await reverseReferralCommissionForLoan(prisma, { tenantId: ctx.tenantId, loanId: ctx.loanId })
      await createNote(
        ctx.loanId,
        "escalation_default",
        "Loan status changed to DEFAULTED — 60 days overdue",
        ctx.tenantId
      )
      // The DEFAULTED flip above is business logic and happens whenever the loan is still in
      // arrears. The borrower notification does not go to a loan that has since left the
      // statuses a notice reaches, or a held loan or client (attorney referral, write-off, an
      // arrangement or plan, a death, a debt-review notice; lib/collections/dunning-holds.ts):
      // skipped, and said so.
      const hold = await loanDunningHold(prisma, { tenantId: ctx.tenantId, loanId: ctx.loanId, statuses: NOTICE_LOAN_STATUSES })
      if (hold) {
        console.warn(`[escalation] ${ctx.loanRef}: loan_overdue defaulted notice not sent: ${hold}`)
        return `${ctx.loanRef}: marked DEFAULTED at ${ctx.daysInArrears} DPD; borrower notification skipped (dunning hold): ${hold}`
      }
      // A consumer is messaged as the borrower; an entity borrower (no
      // Client) through the people who act for it, in copy that names the
      // entity (triggerNotification → lib/asset-finance/entity-notifications.ts).
      if (ctx.daysInArrears > DEFAULT_NOTICE_MAX_DPD) {
        return `${ctx.loanRef}: marked DEFAULTED at ${ctx.daysInArrears} DPD; borrower notification skipped (past the ${DEFAULT_NOTICE_MAX_DPD} DPD notice window)`
      }
      try {
        await triggerNotification({
          tenantId: ctx.tenantId,
          event: "loan_overdue",
          loanId: ctx.loanId,
          ...(ctx.clientId !== null ? { clientId: ctx.clientId } : {}),
          data: { daysOverdue: ctx.daysInArrears, amount: ctx.arrearsAmount + charges, escalation: "defaulted" },
        })
      } catch (err) {
        // The flip and note above stand, so this rule will not run again: log the
        // cause and count the failure so the run reports it.
        console.error(`[escalation] ${ctx.loanRef}: DEFAULTED notice failed:`, err)
        // A database that is down is the tenant's fault to retry, not "the notice failed".
        if (isDatabaseInfrastructureError(err)) throw err
        throw new Error(`${ctx.loanRef}: marked DEFAULTED but the borrower notice failed; see the server log`)
      }
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

/** Every ACTIVE tenant, each in its own frame (lib/ops/tenant-sweep.ts). */
export async function processEscalations(): Promise<EscalationResult> {
  const total: EscalationResult = { processed: 0, errors: 0, details: [], tenants: 0, failedTenants: 0 }
  const outcomes = await sweepActiveTenants("escalations", (tenant) => processTenantEscalations(tenant))
  total.tenants = outcomes.length
  if (outcomes.length === 0) total.details.push("No active tenant found")
  for (const outcome of outcomes) {
    if (!outcome.ok) {
      total.errors++
      total.failedTenants++
      total.details.push(tenantFailureDetail(outcome.tenant))
      continue
    }
    total.processed += outcome.value.processed
    total.errors += outcome.value.errors
    total.details.push(...outcome.value.details)
  }
  return total
}

async function processTenantEscalations(tenant: SweepTenant): Promise<EscalationResult> {
  await ensureDpdCurrent(tenant.id)
  const result: EscalationResult = { processed: 0, errors: 0, details: [], tenants: 0, failedTenants: 0 }

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

  let loansFailed = 0
  for (const loan of loans) {
    let loanErrored = false
    let loanAdvanced = false
    for (const rule of RULES) {
      if (loan.daysInArrears < rule.minDays) continue

      // The reservation this rule holds, so a failure anywhere below gives it back.
      let reserved: { key: string; at: Date } | null = null
      try {
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

        // noteExists above is checked before the rule writes its note, so two
        // overlapping runs (a takeover of a runner that only lost its heartbeat)
        // can both get here and both flip the status and notify the borrower. One
        // reservation per loan, rule and SAST day lets only one act. It is given
        // back if the rule fails; but a failure of one loan is a per-item error, which
        // leaves the run DONE and unretried, so the rule is next tried tomorrow.
        const reservation = `escalation:${loan.id}:${rule.noteType}`
        const reservedAt = new Date()
        if (!(await reserveOnce(tenant.id, reservation, reservedAt))) {
          result.details.push(`Skip ${loan.reference} ${rule.noteType}: another run is already handling it today`)
          continue
        }
        reserved = { key: reservation, at: reservedAt }
        const outcome = await rule.action(ctx)
        if (typeof outcome !== "string") {
          // The later rules (the 90-DPD Section 129 flag) read the loan as it was at the start of the run, and this
          // loan is not that loan any more.
          result.details.push(outcome.settled)
          break
        }
        result.processed++
        loanAdvanced = true
        result.details.push(outcome)
      } catch (err) {
        if (reserved) {
          try {
            await releaseReservation(reserved.key, reserved.at)
          } catch (releaseErr) {
            console.error(`[escalation] ${loan.reference} ${rule.noteType}: could not give the reservation back:`, releaseErr)
          }
        }
        // A fault that is the database's is the tenant's, not this loan's: it is retried.
        if (isDatabaseInfrastructureError(err)) throw err
        loanErrored = true
        console.error(`[escalation] ${loan.reference} ${rule.noteType} failed:`, err)
        result.details.push(`Error ${loan.reference} ${rule.noteType}: failed; see the server log`)
        // This is a Section 129 legal notice / DEFAULTED status / commission
        // clawback pipeline (see the module doc). A rule that keeps throwing
        // was previously invisible: no counter, no ok field, and the loan's
        // escalation simply never advances. Count it so the run reports it. It
        // does not fail the tenant: the other loans are escalated.
        result.errors++
      }
    }
    if (loanErrored && !loanAdvanced) loansFailed++
  }
  // Every loan failing means the tenant is broken, not that a few loans were: the retry is for it.
  if (loans.length > 0 && loansFailed === loans.length) {
    throw new Error(`every one of the ${loans.length} loan(s) failed; see the errors logged above`)
  }

  return result
}
