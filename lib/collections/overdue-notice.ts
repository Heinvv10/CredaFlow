import { triggerNotification } from "@/lib/notifications"
import { isDatabaseInfrastructureError } from "@/lib/ops/db-fault"
import { releaseReservation, reserveOnce } from "@/lib/ops/send-reservation"

export interface OverdueTrigger {
  noteType: string
  daysUntilDue: number
  channels: ReadonlyArray<string>
}

/** The part of a cron's result an overdue notice reports into. */
export interface OverdueReport {
  errors: number
  details: string[]
}

/**
 * Why `loan_overdue`'s WhatsApp leg must be dropped for this trigger, or
 * undefined when there is nothing to drop.
 *
 * Every trigger with `daysUntilDue < 0` also fires the `loan_overdue`
 * notification, whose WhatsApp leg sends `loan_overdue_1d`. Where that
 * trigger ALSO has its own WhatsApp leg, the borrower gets two dunning
 * WhatsApps the same morning.
 *
 * DERIVED from the trigger's own `channels`, never from a list of offsets:
 * a hardcoded `-1, -3` silently reintroduces the duplicate the day a trigger
 * is added, and silently suppresses a legitimate notice the day one loses its
 * WhatsApp leg.
 *
 * Scope is deliberately the leg, not the event. `loan_overdue` also carries
 * the "Payment Overdue Notice" EMAIL, which no reminder stage sends at all —
 * suppressing the event would take that email away from the borrower.
 *
 * CHOSEN, not forced: this asks by DESIGN (does the stage carry WhatsApp?),
 * not by outcome. The stage's own result is in scope at the call site
 * (`channelsSent`), so `suppress only if channelsSent.includes("whatsapp")`
 * is available — it is not taken because a QUEUED or reconciliation-pending
 * leg would then reinstate `loan_overdue`'s WhatsApp and reintroduce the
 * duplicate this exists to prevent. The cost of the choice: if the stage's
 * own WABA row is missing, its leg is skipped and `loan_overdue`'s is
 * suppressed, so no WhatsApp goes out — the borrower still gets the email,
 * and the missing row is already a counted warning for the tenant.
 */
export function overdueWhatsAppSuppressionReason(trigger: Pick<OverdueTrigger, "noteType" | "channels">): string | undefined {
  if (!trigger.channels.includes("whatsapp")) return undefined
  return `the ${trigger.noteType} reminder stage already sends a WhatsApp at this offset`
}

async function giveBack(key: string, at: Date, loanRef: string): Promise<void> {
  try {
    await releaseReservation(key, at)
  } catch (releaseErr) {
    // The original failure is what the run reports; this one is only logged.
    console.error(`[reminders] ${loanRef} loan_overdue: could not give the reservation back:`, releaseErr)
  }
}

/**
 * The `loan_overdue` notification of an overdue trigger, at most once per loan
 * per trigger per SAST day, for a consumer and an entity loan alike.
 *
 * The trigger's own LoanNote is written only when a leg reached a borrower, so
 * it cannot stop a same-day re-run on which no leg did (SMS off and no WhatsApp
 * number, every leg blocked by consent): that run fired the notification, and
 * its email, again. The reservation is taken before the notification.
 *
 * Awaited, so a failure lands in this run's report: logged and counted, never
 * swallowed. That covers a throw AND a leg the notification reports as failed (a
 * provider's definite rejection, no Contact, another person's Contact, a missing
 * template). Either way the reservation is given back, so the next run tries
 * again: a leg that went out is not resent (each leg has its own once-a-day
 * idempotency key in lib/notifications.ts), and a failed one is re-attempted or,
 * if its rejection is final, reported again rather than left looking done.
 */
export async function fireOverdueNotice(args: {
  tenantId: string
  loan: { id: string; reference: string }
  clientId?: string
  trigger: OverdueTrigger
  arrearsDue: number
  report: OverdueReport
}): Promise<void> {
  const { tenantId, loan, trigger, report } = args
  const reservation = `send:${loan.id}:${trigger.noteType}:loan_overdue`
  const reservedAt = new Date()
  if (!(await reserveOnce(tenantId, reservation, reservedAt))) {
    report.details.push(`Skip ${loan.reference}: loan_overdue for ${trigger.noteType} already fired today`)
    return
  }
  let failedLegs: string[]
  try {
    const outcome = await triggerNotification({
      tenantId,
      event: "loan_overdue",
      loanId: loan.id,
      ...(args.clientId ? { clientId: args.clientId } : {}),
      data: { daysOverdue: Math.abs(trigger.daysUntilDue), amount: args.arrearsDue },
      // The event still fires — email and the NotificationLog record are
      // unchanged. Only the WhatsApp leg is dropped, and only where this
      // trigger's own stage already carries one.
      suppressWhatsAppReason: overdueWhatsAppSuppressionReason(trigger),
    })
    failedLegs = [...new Set(outcome?.failedLegs ?? [])]
  } catch (err) {
    await giveBack(reservation, reservedAt, loan.reference)
    // A database fault is the tenant's, not this loan's: retried (the per-loan loop rethrows it).
    if (isDatabaseInfrastructureError(err)) throw err
    console.error(`[reminders] ${loan.reference} loan_overdue failed:`, err)
    report.errors++
    report.details.push(`Error ${loan.reference} loan_overdue: failed; see the server log`)
    return
  }
  if (failedLegs.length > 0) {
    await giveBack(reservation, reservedAt, loan.reference)
    console.error(`[reminders] ${loan.reference} loan_overdue: the ${failedLegs.join("+")} leg failed; the cause is in the notification log`)
    report.errors++
    report.details.push(`Error ${loan.reference} loan_overdue: ${failedLegs.join("+")} failed; see the notification log`)
  }
}
