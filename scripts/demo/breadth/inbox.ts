/**
 * Client conversations in the shared inbox. Staff e-mail a borrower from the
 * client screen's "Message" drawer (POST /api/clients/[id]/messages), then
 * work the thread in the inbox: an internal note, a claim or reassignment
 * (POST …/conversations/[id]/assignment), a follow-up reply on the thread
 * (POST …/reply) and a status change (PATCH …/conversations/[id]).
 *
 * Outbound only: inbound e-mail needs a polled mailbox and WhatsApp is off in
 * this deployment, so no customer message is invented. Every e-mail goes
 * through the product's send pipeline to the sim's SMTP sink and is recorded
 * SENT because the provider accepted it.
 */
import type { SimClient } from "../sim/api"
import { shiftBusinessDays } from "../simulate/dates"
import { afterOrigination, as, beforeEnd, clientOf, operationId, recall, remember, step, type Breadth } from "./context"
import type { StaffKey } from "./staff"

interface Thread {
  personaId: string
  day: (b: Breadth) => string
  author: "officer" | StaffKey
  subject: string
  text: string
  note: string
  /** Who the thread ends with; null = the author keeps it. */
  reassignTo: StaffKey | null
  followUp: string | null
  finalStatus: "OPEN" | "PENDING_CUSTOMER" | "CLOSED"
}

const THREADS: readonly Thread[] = [
  { personaId: "bg-08", day: (b) => afterOrigination(b, "bg-08", 20), author: "officer", subject: "Your debit order date",
    text: "Good day,\n\nAs requested, your instalment is collected on the 25th of each month. Please keep the account funded the day before.\n\nRegards, Acme Lending",
    note: "Client asked by phone to confirm the collection date.", reassignTo: null, followUp: null, finalStatus: "CLOSED" },
  { personaId: "bg-19", day: (b) => beforeEnd(b, 18), author: "officer", subject: "Missed instalment on your loan",
    text: "Good day,\n\nYour instalment due this month was not received. Please contact us to arrange payment so that we can avoid further collection steps.\n\nRegards, Acme Lending",
    note: "First missed instalment; sent the courtesy e-mail before the formal reminder.", reassignTo: "branchManager",
    followUp: "Good day,\n\nWe have not yet heard from you about the missed instalment. Please call us on 011 000 0001.\n\nRegards, Acme Lending", finalStatus: "PENDING_CUSTOMER" },
  { personaId: "bg-13", day: (b) => beforeEnd(b, 3), author: "officer2", subject: "Settlement figure requested",
    text: "Good day,\n\nThank you for your request. Your settlement figure is being prepared and a certificate of balance will follow within one business day.\n\nRegards, Acme Lending",
    note: "Settlement quote requested; complaint C5 logged about the delay.", reassignTo: null, followUp: null, finalStatus: "OPEN" },
  { personaId: "bg-16", day: (b) => afterOrigination(b, "bg-16", 31), author: "officer2", subject: "Your EFT payment has been allocated",
    text: "Good day,\n\nWe found your EFT payment on our bank statement and have allocated it to your loan. Please use your loan reference on future payments.\n\nRegards, Acme Lending",
    note: "Linked to complaint C1 (unallocated EFT).", reassignTo: null, followUp: null, finalStatus: "CLOSED" },
]

async function author(b: Breadth, key: Thread["author"]): Promise<SimClient> {
  return key === "officer" ? b.sim.actors.officer : as(b, key)
}

export function scheduleInbox(b: Breadth): void {
  THREADS.forEach((t) => {
    const chain = `inbox-${t.personaId}`
    const day0 = t.day(b)
    step(b, chain, "message", day0, "12:05", async () => {
      const c = await author(b, t.author)
      const res = await c.post<{ conversationId: string; status: string }>(`/api/clients/${clientOf(b, t.personaId)}/messages`, {
        channel: "EMAIL", subject: t.subject, text: t.text, operationId: operationId(`breadth:${chain}:message`),
      }, { expect: [200] })
      if (res.json?.status !== "SENT" || !res.json.conversationId) throw new Error(`client e-mail not accepted: ${res.text.slice(0, 200)}`)
      remember(b, chain, res.json.conversationId)
      await c.post(`/api/inbox/conversations/${res.json.conversationId}/note`, { text: t.note }, { expect: [200, 201] })
      await c.post(`/api/inbox/conversations/${res.json.conversationId}/assignment`, { action: "claim" }, { expect: [200] })
    })
    step(b, chain, "follow-up", shiftBusinessDays(day0, 3), "12:25", async () => {
      const conversationId = recall(b, chain)
      const c = await author(b, t.author)
      if (t.reassignTo) {
        const to = await as(b, t.reassignTo)
        await c.post(`/api/inbox/conversations/${conversationId}/assignment`, { action: "reassign", assigneeId: to.user?.id }, { expect: [200] })
      }
      if (t.followUp) {
        const sender = t.reassignTo ? await as(b, t.reassignTo) : c
        const res = await sender.post<{ ok: boolean; reason?: string }>(`/api/inbox/conversations/${conversationId}/reply`, {
          channel: "EMAIL", text: t.followUp, operationId: operationId(`breadth:${chain}:follow-up`),
        }, { expect: [200] })
        if (!res.json?.ok) throw new Error(`inbox reply refused: ${res.text.slice(0, 200)}`)
      }
      if (t.finalStatus !== "OPEN") await c.patch(`/api/inbox/conversations/${conversationId}`, { status: t.finalStatus })
    })
  })
}
