import { createHash } from "node:crypto"
import { prisma } from "@/lib/prisma"
import { AuditAction, logAudit } from "@/lib/audit"
import { simulatesSection129, SECTION129_SIMULATED_NOTE } from "@/lib/collections/section129-email"
import type { EmailAttachment } from "@/lib/email/service"
import { sendAgentMessage } from "@/lib/messaging/agent-message"

export type DeliveryLeg = { channel: "EMAIL" | "WHATSAPP"; outcome: "sent" | "pending" | "simulated" | "not_sent"; detail?: string }

/** A deterministic operation id: a retried delivery of the same document is one Message, not two. */
export function operationIdFor(what: string): string {
  const h = createHash("sha256").update(what).digest("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/** One line for a note or a toast. Never says a channel carried what it did not. */
export function deliverySummary(legs: DeliveryLeg[]): string {
  return legs.map((leg) => {
    const channel = leg.channel === "EMAIL" ? "Email" : "WhatsApp"
    if (leg.outcome === "simulated") return `${channel}: ${SECTION129_SIMULATED_NOTE}`
    if (leg.outcome === "sent") return `${channel}: accepted by the provider`
    if (leg.outcome === "pending") return `${channel}: queued`
    return `${channel}: not sent (${leg.detail ?? "unavailable"})`
  }).join("; ")
}

/**
 * Tells the borrower about a document, through the one send pipeline (consent, holds, the comms timeline, idempotency).
 * Email, and WhatsApp where the lender's channel and the borrower's consent allow it; the PDF goes on the email only.
 * On a demo stack a `.invalid` mailbox of a demo lender is simulated, as a Section 129 notice is: nothing leaves, and the
 * outcome says so. Never throws: a document stands whether or not its notice went out, and the audit row says which.
 */
export async function deliverToBorrower(args: {
  tenantId: string
  clientId: string
  staff: { id: string; email: string }
  entity: { type: "LoanApplication" | "Loan"; id: string }
  what: string
  subject: string
  text: string
  operationId: string
  attachments?: EmailAttachment[]
  /** A dunning category (lib/messaging/dunning-category.ts) puts a retry under the client's holds. */
  category?: string
}): Promise<DeliveryLeg[]> {
  const { tenantId, clientId, staff, entity } = args
  const legs: DeliveryLeg[] = []
  const leg = async (channel: DeliveryLeg["channel"], contactId: string) => {
    const sent = await sendAgentMessage({
      tenantId, contactId, channel, text: args.text, subject: args.subject, agentUserId: staff.id, operationId: args.operationId, category: args.category,
      ...(entity.type === "Loan" ? { loanId: entity.id } : {}),
      ...(channel === "EMAIL" && args.attachments ? { attachments: args.attachments } : {}),
    })
    legs.push(sent.ok
      ? { channel, outcome: sent.outcome === "pending" ? "pending" : "sent" }
      : { channel, outcome: "not_sent", detail: sent.detail ?? sent.reason })
  }
  try {
    const [client, contact] = await Promise.all([
      prisma.client.findFirst({ where: { id: clientId, tenantId }, select: { email: true, whatsapp: true } }),
      prisma.contact.findFirst({ where: { tenantId, clientId } }),
    ])
    if (!contact) {
      legs.push({ channel: "EMAIL", outcome: "not_sent", detail: "no comms Contact on file for this client" })
    } else {
      if (client?.email && await simulatesSection129(tenantId, client.email)) legs.push({ channel: "EMAIL", outcome: "simulated" })
      else await leg("EMAIL", contact.id)
      if (client?.whatsapp) await leg("WHATSAPP", contact.id)
    }
  } catch (error) {
    console.error(`[non-nca-documents] notice of ${args.what} failed:`, error instanceof Error ? error.message : "unknown error")
    legs.push({ channel: "EMAIL", outcome: "not_sent", detail: "the notice could not be prepared" })
  }
  await logAudit({
    tenantId, userId: staff.id, userEmail: staff.email, action: AuditAction.LOAN_DOCUMENT_NOTICE, entity: entity.type, entityId: entity.id,
    newValue: { what: args.what, legs },
  })
  return legs
}
