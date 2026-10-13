import { NextRequest, NextResponse } from "next/server"
import { prisma } from "@/lib/prisma"
import { sendEmail } from "@/lib/email/service"
import { WA_TEMPLATES } from "@/lib/whatsapp"
import { sendWhatsAppForTenant } from "@/lib/whatsapp/send-for-tenant"
import { getDefaultTenantId } from "@/lib/tenant"
import { formatDate } from "@/lib/utils"
import { paymentDueReminderEmail } from "@/lib/email/templates/portal"
import { verifyCronSecret } from "@/lib/cron-auth"
import { getChannelAvailability } from "@/lib/messaging/channel-availability"
import { getCommsSettings } from "@/lib/inbox/settings"
import { sendMessage, SendBlockedError } from "@/lib/messaging/send"
import { messageDeliveryOutcome } from "@/lib/messaging/delivery-outcome"
import { isPaymentRemindersNewSendEnabled } from "@/lib/messaging/flags"
import { waTemplateVarsFor } from "@/lib/whatsapp/template-vars"
import { getLenderIdentity } from "@/lib/config/identity"
import { sastCalendarDate, sastStartOfDay } from "@/lib/date/sast"
import { chargesOutstandingAt } from "@/lib/loan/charges-replay"

/**
 * Payment reminder cron — one courtesy reminder per loan, REMINDER_LEAD_DAYS
 * before the instalment falls due.
 *
 * Scheduled in-process by instrumentation.ts (daily 07:00) on every container
 * with APP_MODE != "client". That coupling matters: this route's disposition
 * and that cron.schedule line have to be reasoned about together — changing
 * one without the other either leaves a nightly 404 or a silently dead job.
 *
 * Two properties below are load-bearing rather than incidental:
 *
 *  1. It sends ONCE per instalment. Mailing everything due within the next
 *     3 days on every run would give a single instalment a reminder on day 3,
 *     day 2, day 1 and day 0 — roughly four messages, across both email and
 *     WhatsApp. What prevents that is the durable marker, not a narrow
 *     window: the window stays open to the due date precisely so a FAILED
 *     send can still be retried.
 *  2. Nothing is sent without checking consent. Reminders are service comms on
 *     a credit agreement, but a borrower who has opted out or been marked
 *     do-not-contact must still be suppressed.
 */
const REMINDER_LEAD_DAYS = 3
const NOTE_TYPE = "payment_due_reminder"

// SAST midnight. The job itself fires at 07:00 SAST, comfortably inside the
// same UTC day, but `dueDate` is compared here too, and an instalment due at
// 23:30 SAST sits on the next UTC day. A UTC day boundary would make
// `daysBetween` read 2 where the borrower sees 3, and the courtesy reminder
// would go out a day late.
function startOfDay(d: Date): Date {
  return sastStartOfDay(d)
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000)
}

/**
 * Day component for the send reservation. Same shape as the collections cron's,
 * deliberately — see the idempotencyKey note at the WhatsApp leg for why its
 * absence is not a cosmetic difference.
 */
function localDayKey(d: Date): string {
  return sastCalendarDate(d)
}

/**
 * Durable marker, the same LoanNote mechanism the collections `reminders` cron
 * uses. It is what makes a re-run safe — a container restart or a manual invoke
 * must not send twice.
 *
 * The lookback spans the whole reminder window rather than just today. That is
 * deliberate and is what lets a FAILED send be retried: a note is only written
 * for a terminal outcome (delivered, or blocked by consent), so a transient
 * delivery failure leaves no marker and the schedule is picked up again on the
 * next run. A today-only lookback combined with an exact-day trigger would have
 * meant a failed reminder was never retried at all.
 *
 * It deliberately does NOT key on the schedule id. A reminder is a message to a
 * borrower about their loan, so at most one per loan per window is correct even
 * where two instalments share a due date. LoanNote has no scheduleId column to
 * key on in any event.
 *
 * The marker is also the only durable record that this job ran: the WhatsApp
 * client writes nothing to the database, so without it a send can leave no
 * auditable trace at all.
 *
 * KNOWN LIMITATION (not closed here): this is a read-then-write, and LoanNote
 * has no unique constraint covering the occurrence, so two genuinely concurrent
 * invocations could both observe no marker and both send. Closing it properly
 * needs a DB-enforced reservation — a unique index on
 * (tenantId, loanId, type, day) — which is a migration and therefore its own
 * change. In practice one in-process scheduler fires this daily; a manual
 * invoke would have to coincide inside the dispatch window to collide.
 */
async function alreadyReminded(loanId: string, tenantId: string): Promise<boolean> {
  const since = startOfDay(new Date())
  since.setDate(since.getDate() - REMINDER_LEAD_DAYS)

  const existing = await prisma.loanNote.findFirst({
    where: { tenantId, loanId, type: NOTE_TYPE, createdAt: { gte: since } },
  })
  return existing !== null
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const denied = verifyCronSecret(req)
  if (denied) return denied

  const tenantId = await getDefaultTenantId()
  // Throws LenderIdentityError when unconfigured: no reminder goes out signed
  // with a default name or support number.
  const identity = await getLenderIdentity(tenantId)

  // Queried as a generous superset, then filtered to the reminder window below.
  // Widening the query keeps the boundary safe: a dueDate stored at midnight is
  // only a partial day away from `now` at 07:00.
  const now = new Date()
  const windowEnd = new Date(now.getTime() + (REMINDER_LEAD_DAYS + 2) * 86_400_000)

  const schedules = await prisma.repaymentSchedule.findMany({
    where: {
      tenantId,
      dueDate: { gte: startOfDay(now), lte: windowEnd },
      status: { in: ["PENDING", "PARTIAL"] },
    },
    include: {
      loan: {
        select: {
          id: true,
          reference: true,
          client: {
            select: {
              firstName: true,
              lastName: true,
              contact: {
                select: {
                  id: true,
                  primaryEmail: true,
                  primaryPhone: true,
                  primaryWaJid: true,
                  blockedAt: true,
                  status: true,
                },
              },
            },
          },
        },
      },
    },
  })

  const settings = await getCommsSettings(tenantId)

  // Looked up ONCE, before the loop, and only on the new path. Its own key —
  // NOT `payment_reminder_whatsapp`, which is the `{{body}}` passthrough that
  // lib/collections/reminders.ts owns for a different cron on different days.
  const newSend = isPaymentRemindersNewSendEnabled()
  let templateWa: Awaited<ReturnType<typeof prisma.messageTemplate.findFirst>> = null
  // Set when the WhatsApp template is unusable. It disables the WhatsApp leg
  // ONLY and makes the run report failure at the end — it does NOT abort
  // before the loop. Aborting would take EMAIL down with it, and email has
  // nothing to do with a WABA template gap: a borrower would lose the reminder
  // they would otherwise have received, to protect a channel that was already
  // not going to reach them. Loud and degraded beats silent and total.
  let waTemplateError: string | null = null
  if (newSend) {
    templateWa = await prisma.messageTemplate.findFirst({
      where: { tenantId, key: "payment_due_3d_whatsapp", channel: "WHATSAPP", active: true },
    })
    // Never silently fall back to the legacy free-text sender: a flag that is
    // on while the template is missing means the tenant's templates were
    // seeded incompletely, and a quiet fallback would hide that until someone read
    // the logs.
    if (!templateWa) {
      waTemplateError =
        "payment_due_3d_whatsapp missing or inactive — "
        + "seed the default templates (seedDefaultMessageTemplates in lib/messaging/default-templates.ts) before flipping the flag"
    } else if (templateWa.statutoryOverride !== false) {
      // Mirrors the collections cron's assertion. A payment reminder is SERVICE
      // category; it must never bypass the consent + opt-out gate the way an
      // s.129 notice lawfully does.
      waTemplateError =
        "payment_due_3d_whatsapp has statutoryOverride=true — payment reminders are "
        + "SERVICE category and must NOT bypass eligibility"
    }
    if (waTemplateError) {
      console.error(`[cron/${NOTE_TYPE}] WhatsApp leg disabled: ${waTemplateError}`)
    }
  }

  let sent = 0
  let suppressed = 0
  let failed = 0
  let needsReconciliation = 0
  let skipped = 0
  let due = 0

  for (const schedule of schedules) {
    // Eligible from the lead day up to the due date. The marker below — not
    // this window — is what prevents repeat sends; the window stays open so a
    // reminder whose delivery FAILED on the lead day can still be retried
    // before the instalment falls due.
    const daysUntilDue = daysBetween(now, schedule.dueDate)
    if (daysUntilDue < 0 || daysUntilDue > REMINDER_LEAD_DAYS) continue
    const { loan } = schedule
    // Reminders address a natural person; an entity borrower is not reminded here.
    if (!loan.client) continue
    due++

    const clientName = `${loan.client.firstName} ${loan.client.lastName}`

    if (await alreadyReminded(loan.id, tenantId)) {
      skipped++
      console.log(`[cron/${NOTE_TYPE}] Skip ${loan.reference}: already reminded for this instalment`)
      continue
    }

    // No Contact row means no consent record and no channel identities, so
    // there is nothing we are entitled to send to. Suppress rather than fall
    // back to the raw client fields — that fallback would be a send we cannot
    // show consent for.
    const contact = loan.client.contact
    if (!contact) {
      suppressed++
      console.warn(`[cron/${NOTE_TYPE}] Suppressed ${loan.reference}: client has no contact record`)
      continue
    }

    const availability = await getChannelAvailability({
      tenantId,
      contact,
      whatsappEnabled: settings.whatsappEnabled,
    })

    // What the borrower must pay includes default charges outstanding (0 while
    // the tenant's flag is off, so the reminder is unchanged).
    const charges = await chargesOutstandingAt(prisma, { tenantId, loanId: loan.id }, now)
    const amountDue = schedule.totalDue - schedule.totalPaid + charges
    const dueDateLabel = formatDate(schedule.dueDate)
    const delivered: string[] = []
    const blocked: string[] = []
    // A channel we were ALLOWED to use but which did not deliver. Distinct from
    // `blocked` (consent/config said no, which is terminal).
    let deliveryFailed = false
    // ...and of those, whether any outcome was AMBIGUOUS. Both senders classify
    // their failures, and an ambiguous one means the provider may already have
    // dispatched (a timeout after Graph accepted; a WA 2xx with no message id).
    // Replaying that would produce the very duplicate this route must not
    // send, so ambiguity BLOCKS the retry and is flagged for reconciliation.
    const ambiguous: string[] = []

    if (availability.EMAIL.enabled) {
      // Invariant from getChannelAvailability: enabled:true always carries toValue.
      const result = await sendEmail({
        tenantId,
        to: availability.EMAIL.toValue!,
        toName: clientName,
        subject: `Payment reminder — ${identity.tradingName}`,
        html: paymentDueReminderEmail(identity, clientName, amountDue, dueDateLabel, loan.reference),
        category: NOTE_TYPE,
        referenceId: schedule.id,
      })
      if (result.ok) {
        delivered.push("email")
      } else {
        deliveryFailed = true
        if (result.providerOutcome === "AMBIGUOUS") ambiguous.push("email")
        console.error(
          `[cron/${NOTE_TYPE}] Email ${result.providerOutcome} for ${loan.reference}: ${result.error}`,
        )
      }
    } else {
      blocked.push(`email (${availability.EMAIL.reason})`)
    }

    if (availability.WHATSAPP.enabled) {
      const amountStr = new Intl.NumberFormat("en-ZA", {
        style: "currency",
        currency: "ZAR",
      }).format(amountDue / 100)
      // Awaited, not fire-and-forget: the LoanNote written
      // below is the audit record of what was sent, so it must not be written
      // before the send has actually resolved.
      try {
        if (newSend && waTemplateError) {
          // Terminal for this run and not a delivery failure, so it is recorded
          // like any other blocked channel: the marker below may still be
          // written off a successful email, which is correct — the reminder DID
          // reach the borrower.
          blocked.push(`whatsapp (${waTemplateError})`)
        } else if (newSend) {
          // Template path. sendWhatsAppForTenant takes no template, so on
          // WA_CLOUD it can only free-text — which Meta permits solely inside
          // the 24h service window. A reminder is by definition unprompted, so
          // the borrower is almost never inside it. Without an approved
          // template every reminder would therefore be refused
          // WA_OUTSIDE_WINDOW_NEEDS_TEMPLATE. sendMessage() selects and fills
          // one.
          const sendResult = await sendMessage({
            contactId: contact.id,
            channel: "WHATSAPP",
            template: templateWa!,
            vars: waTemplateVarsFor("payment_due_3d", {
              firstName: loan.client.firstName,
              reference: loan.reference,
              amount: amountStr,
              outstanding: amountStr,
              dueDate: dueDateLabel,
              supportPhone: identity.collectionsPhone,
            }),
            toValue: availability.WHATSAPP.toValue!,
            category: NOTE_TYPE,
            loanId: loan.id,
            // Keyed on the SCHEDULE, not the loan: a loan has many instalments
            // and each earns its own reminder. Distinct from the collections
            // cron's `collections:` namespace, which is keyed per trigger per
            // day — the two crons must not dedupe each other.
            //
            // The DAY component is load-bearing, not decoration. sendMessage()
            // returns an existing reservation for a repeated key WITHOUT
            // dispatching (send.ts:392-412) unless rearmDefinitelyRejected is
            // passed, which this route does not pass. A key fixed for the whole
            // reminder window would therefore mean: one PERMANENT classification
            // (403, invalid token, rejected template) on day 3 is replayed as
            // the same dead result on days 2, 1 and 0, with no provider call
            // ever made again — while the marker logic below, seeing a failure,
            // correctly declines to write a marker and the logs keep saying
            // "will retry". The borrower silently gets nothing. One occurrence
            // per day restores the retry the surrounding code already promises.
            idempotencyKey: `payment-reminder:${schedule.id}:WHATSAPP:${localDayKey(now)}`,
          })
          const outcome = messageDeliveryOutcome(sendResult.status)
          if (outcome === "sent" || outcome === "simulated") {
            delivered.push("whatsapp")
          } else if (outcome === "pending") {
            // QUEUED/RETRYING is not delivery and not a definite rejection.
            // Treat it as ambiguous so it is neither counted as sent nor
            // replayed — the retry sweep owns it from here.
            deliveryFailed = true
            ambiguous.push("whatsapp")
          } else {
            deliveryFailed = true
            console.error(
              `[cron/${NOTE_TYPE}] WA not sent for ${loan.reference}: status ${sendResult.status}`,
            )
          }
        } else {
          // RESOLVES with { ok: false } on a provider rejection rather than
          // throwing, so the result has to be inspected. Treating "did not
          // throw" as delivered would record a send that never happened — and,
          // worse, write the marker that suppresses the retry.
          //
          // Routed through the tenant's configured provider, not the Baileys
          // bridge directly: on WA_CLOUD the bridge is a transport with no
          // numbers paired, so every reminder would fail.
          const waResult = await sendWhatsAppForTenant({
            tenantId,
            // Lets the Cloud sender read the 24h service window. Omitting it
            // makes every reminder resolve to a null window, so a borrower who
            // messaged minutes ago would still be refused as out-of-window.
            contactId: contact.id,
            to: availability.WHATSAPP.toValue!,
            message: WA_TEMPLATES.payment_due_3d(clientName, amountStr, dueDateLabel, loan.reference),
          })
          if (waResult?.ok) {
            delivered.push("whatsapp")
          } else {
            deliveryFailed = true
            if (waResult?.providerOutcome === "AMBIGUOUS") ambiguous.push("whatsapp")
            console.error(
              `[cron/${NOTE_TYPE}] WA ${waResult?.providerOutcome ?? "failed"} for ${loan.reference}: ${waResult?.error ?? "unknown"}`,
            )
          }
        }
      } catch (err) {
        if (err instanceof SendBlockedError) {
          // A DEFINITE, expected outcome, not an unknown one. canSendTx
          // re-evaluates consent and opt-out independently of the coarser
          // getChannelAvailability gate above, so it legitimately blocks sends
          // that got this far. Every other sendMessage() caller special-cases
          // it (lib/notifications.ts:712, lib/inbox/dispatch.ts:175,
          // lib/messaging/agent-message.ts:120). Filing it as "ambiguous" would
          // write a LoanNote claiming the message "may have been delivered"
          // about a message we deliberately refused to send — a false statement
          // in the record a POPIA or NCA auditor reads.
          blocked.push(`whatsapp (${err.message})`)
          console.warn(`[cron/${NOTE_TYPE}] WA blocked for ${loan.reference}: ${err.message}`)
        } else {
          // Unclassified throw: the request may still have reached the sender, so
          // it is treated as ambiguous rather than replayed.
          deliveryFailed = true
          ambiguous.push("whatsapp")
          console.error(`[cron/${NOTE_TYPE}] WA threw for ${loan.reference}:`, err)
        }
      }
    } else {
      blocked.push(`whatsapp (${availability.WHATSAPP.reason})`)
    }

    if (delivered.length > 0) sent++
    else if (ambiguous.length > 0) needsReconciliation++
    else if (deliveryFailed) failed++
    else suppressed++

    // ONLY terminal outcomes are marked. Delivered, or blocked by consent —
    // both mean "this reminder is finished, do not send again".
    //
    // A pure delivery failure is NOT terminal and deliberately writes no
    // marker, so the schedule is retried on the next run while it remains
    // inside the window. Marking it would lose the reminder permanently: the
    // borrower never hears from us, and nothing surfaces the miss.
    // Retry ONLY a definite rejection. An ambiguous outcome falls through and
    // is marked, because it may already have reached the borrower.
    if (delivered.length === 0 && deliveryFailed && ambiguous.length === 0) {
      console.warn(
        `[cron/${NOTE_TYPE}] ${loan.reference}: definitely rejected on every channel, leaving unmarked for retry`,
      )
      continue
    }

    await prisma.loanNote.create({
      data: {
        tenantId,
        loanId: loan.id,
        type: NOTE_TYPE,
        note:
          `Payment reminder for ${loan.reference} (instalment due ${dueDateLabel}, schedule ${schedule.id}): ` +
          (delivered.length > 0 ? `sent via ${delivered.join(" + ")}` : "not sent") +
          (blocked.length > 0 ? `; suppressed: ${blocked.join(", ")}` : "") +
          (ambiguous.length > 0
            ? `; AMBIGUOUS on ${ambiguous.join(", ")} — may have been delivered, replay blocked, needs reconciliation`
            : ""),
        createdBy: "system",
      },
    })
  }

  console.log(
    `[cron/${NOTE_TYPE}] Done — ${due} in window, ${sent} sent, ${suppressed} suppressed, ${failed} failed (will retry), ${needsReconciliation} ambiguous (replay blocked), ${skipped} already handled`,
  )

  const summary = { sent, suppressed, failed, needsReconciliation, skipped, due }

  // Non-200 AFTER the work, not instead of it. The email reminders above have
  // already gone out; the status is what stops a misconfigured WhatsApp leg
  // sitting unnoticed behind a cron that looks like it succeeded.
  //
  // Be precise about what that buys, because it is less than it looks: this
  // route is scheduled IN-PROCESS (instrumentation.ts:69), not by a systemd
  // timer — it is deliberately absent from SYSTEMD_OWNED in
  // instrumentation.cron-census.test.ts. Its caller is callCron()
  // (instrumentation.ts:42-58), which on a non-2xx only writes
  // `[cron] /api/cron/payment-reminders failed: 500` and moves on. There is no
  // retry, no crash, and no unit to go red. The signal is that one log line
  // being distinguishable from the `ok` line — so any alerting must watch the
  // app log, not a systemd unit state.
  //
  // The counts ride along so the log still says exactly what did and did not
  // happen.
  if (waTemplateError) {
    return NextResponse.json({ ...summary, error: waTemplateError }, { status: 500 })
  }

  return NextResponse.json(summary)
}
