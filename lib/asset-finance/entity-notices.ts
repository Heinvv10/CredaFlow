/**
 * The wording of an entity borrower's servicing messages (goal §4.11). Pure:
 * no database, no clock.
 *
 * The consumer copy (lib/notifications.ts, lib/collections/reminders.ts,
 * lib/email/templates/portal.ts) speaks to the borrower: "your loan", "your
 * payment". For a company or trust the reader is a director, trustee or
 * authorised signatory (./entity-contacts.ts), who is not the borrower, so this
 * copy addresses the person and names the entity whose account it is. It is
 * deliberately minimal and factual: the amount, the date, the reference, who
 * to contact. It makes no legal claim and threatens no step.
 *
 * Customer-facing wording: the lender signs it off before go-live, like every
 * other template (CLAUDE.md, outbound customer communication keeps a human gate).
 *
 * WhatsApp bodies are WABA_BODY_TEMPLATES.entity_payment_* (lib/whatsapp/
 * template-vars.ts); this module supplies their variables and the email
 * subject, text and html.
 */
import { escapeHtml, formatDate, formatZAR } from "@/lib/utils"
import { waTemplateVarsFor } from "@/lib/whatsapp/template-vars"
import type { EntityContact } from "./entity-contacts"

export type EntityNoticeKind = "due" | "overdue" | "received"

export interface EntityNoticeFacts {
  kind: EntityNoticeKind
  entityName: string
  reference: string
  /** due/overdue: the amount to pay; received: the amount received (cents) */
  amountCents: number
  /** due: the instalment's due date */
  dueDate?: Date
  /** overdue: days past due, when known */
  daysOverdue?: number
  /** received: the balance after the receipt (cents) */
  outstandingCents?: number
}

export interface EntityNoticeLender {
  tradingName: string
  collectionsPhone: string
}

/** The WhatsApp template event (and seeded row `<event>_whatsapp`) for a kind. */
export const ENTITY_WA_EVENT: Record<EntityNoticeKind, string> = {
  due: "entity_payment_due",
  overdue: "entity_payment_overdue",
  received: "entity_payment_received",
}

/** The seeded email row: a receipt is TRANSACTIONAL, a reminder SERVICE (consent lanes differ). */
export const ENTITY_EMAIL_KEY: Record<EntityNoticeKind, string> = {
  due: "entity_reminder_email",
  overdue: "entity_reminder_email",
  received: "entity_payment_received_email",
}

function sentences(facts: EntityNoticeFacts, lender: EntityNoticeLender): { subject: string; lines: string[] } {
  const amount = formatZAR(facts.amountCents)
  const account = `the ${lender.tradingName} account of ${facts.entityName} (reference ${facts.reference})`
  switch (facts.kind) {
    case "due":
      return {
        subject: `Payment reminder: ${facts.entityName} (${facts.reference})`,
        lines: [
          `A payment of ${amount} on ${account} is due on ${facts.dueDate ? formatDate(facts.dueDate) : "its due date"}.`,
          `Please quote ${facts.reference} as the payment reference.`,
        ],
      }
    case "overdue":
      return {
        subject: `Payment overdue: ${facts.entityName} (${facts.reference})`,
        lines: [
          `A payment of ${amount} on ${account} is overdue${facts.daysOverdue ? ` by ${facts.daysOverdue} days` : ""}.`,
          `Please arrange payment, quoting ${facts.reference}, or contact us on ${lender.collectionsPhone}.`,
        ],
      }
    case "received":
      return {
        subject: `Payment received: ${facts.entityName} (${facts.reference})`,
        lines: [
          `We have received a payment of ${amount} on ${account}.`,
          `The outstanding balance is ${formatZAR(facts.outstandingCents ?? 0)}.`,
        ],
      }
  }
}

/** Email vars for the passthrough rows ({{subject}} / {{text}} / {{html}}). */
export function entityEmailVars(
  facts: EntityNoticeFacts,
  lender: EntityNoticeLender,
  recipient: Pick<EntityContact, "firstName" | "lastName">,
): { subject: string; text: string; html: string } {
  const { subject, lines } = sentences(facts, lender)
  const name = `${recipient.firstName} ${recipient.lastName}`.trim()
  const text = [`Dear ${name},`, ...lines, lender.tradingName].join("\n\n")
  const html = [`Dear ${name},`, ...lines, lender.tradingName]
    .map((line) => `<p style="margin:0 0 16px;color:#444;line-height:1.6;">${escapeHtml(line)}</p>`)
    .join("\n")
  return { subject, text, html }
}

/** WhatsApp vars for ENTITY_WA_EVENT[kind]: exactly what its body declares. */
export function entityWhatsAppVars(
  facts: EntityNoticeFacts,
  lender: EntityNoticeLender,
  recipient: Pick<EntityContact, "firstName">,
): Record<string, string> {
  return waTemplateVarsFor(ENTITY_WA_EVENT[facts.kind], {
    firstName: recipient.firstName,
    reference: facts.reference,
    amount: formatZAR(facts.amountCents),
    outstanding: formatZAR(facts.outstandingCents ?? 0),
    dueDate: facts.dueDate ? formatDate(facts.dueDate) : "",
    supportPhone: lender.collectionsPhone,
    entityName: facts.entityName,
  })
}
