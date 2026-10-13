/**
 * The CRM pipeline as dated staff work, through the routes the CRM screens
 * call: the lead form (POST /api/crm/leads) or the public website forms
 * (/api/website/contact, /api/website/apply — the latter with an agent's
 * referral code), owner assignment and stage moves (PATCH /api/crm/leads/[id],
 * as the kanban does), logged calls/meetings/offers (POST /api/crm/activities),
 * callbacks (PATCH …/callback), tasks (POST/PATCH /api/agent-tasks), e-mail to
 * the lead (POST …/messages, the "Message" drawer — WhatsApp is off in this
 * deployment, so the one-click WhatsApp outreach is not used) and lost reasons
 * (PATCH …/lost) and conversion into a client plus a submitted application
 * (POST …/convert, the Convert form's body).
 *
 * E-mail goes to the sim's SMTP sink, so the Message rows say SENT because the
 * provider accepted them; nothing claims a channel that did not carry it.
 */
import { demoLender } from "../../../prisma/demo-lender"
import { SimClient } from "../sim/api"
import { now } from "../sim/clock"
import { log } from "../sim/env"
import { readDb } from "../sim/readonly-db"
import { addDays, nextBusinessDay, sastInstant, shiftBusinessDays } from "../simulate/dates"
import { as, beforeEnd, fromStart, later, operationId, recall, remember, step, type Breadth } from "./context"
import { LEADS, leadPerson, type LeadPerson, type LeadSpec, type Step } from "./crm-leads"

const BRAND = demoLender().identity.brandName

const rands = (cents: number): string => `R${(cents / 100).toLocaleString("en-ZA")}`

async function ownerClient(b: Breadth, spec: LeadSpec): Promise<SimClient> {
  return spec.owner === "officer2" ? as(b, "officer2") : b.sim.actors.officer
}

async function leadIdByPhone(phone: string): Promise<string> {
  const rows = await readDb().$queryRawUnsafe<Array<{ id: string }>>(`SELECT id FROM "Lead" WHERE phone = $1 ORDER BY "createdAt" DESC LIMIT 1`, phone)
  if (!rows[0]) throw new Error(`no lead with phone ${phone} after the website form`)
  return rows[0].id
}

async function createLead(b: Breadth, spec: LeadSpec, who: LeadPerson): Promise<string> {
  const o = spec.origin
  if (o.kind === "staff") {
    const res = await (await ownerClient(b, spec)).post<{ id: string }>("/api/crm/leads", {
      firstName: who.firstName, lastName: who.lastName, email: who.email, phone: who.phone, source: o.source,
      notes: `Enquired about ${rands(spec.amountRands * 100)}; works at ${who.employerName}.`,
    }, { expect: [201] })
    if (!res.json?.id) throw new Error(`lead create returned no id: ${res.text.slice(0, 200)}`)
    return res.json.id
  }
  const visitor = new SimClient()
  if (o.kind === "contact-form") {
    await visitor.post("/api/website/contact", {
      name: `${who.firstName} ${who.lastName}`, phone: who.phone, email: who.email, turnstileToken: "sim-visitor",
      message: `Hi, I would like a loan of about ${rands(spec.amountRands * 100)}. Please call me back.`,
    }, { expect: [200] })
  } else {
    await visitor.post("/api/website/apply", {
      firstName: who.firstName, lastName: who.lastName, email: who.email, phone: who.phone,
      employmentStatus: "EMPLOYED", employerName: who.employerName,
      monthlyIncome: who.incomeCents / 100, monthlyExpenses: who.expensesCents / 100,
      productType: "PERSONAL", amount: spec.amountRands, termDays: 360, purpose: "Household expenses",
      popiaConsent: true, source: "WEBSITE", referralCode: o.referralCode, turnstileToken: "sim-visitor",
    }, { expect: [200, 201] })
  }
  return leadIdByPhone(who.phone)
}

const activity = (c: SimClient, leadId: string, type: string, subject: string, notes: string): Promise<unknown> =>
  c.post("/api/crm/activities", { leadId, type, subject, notes, completedAt: now().toISOString() }, { expect: [201] })

/** Due/callback instant: the next business day at 10:00, but never past the bake's end. */
function followUp(b: Breadth, day: string): string {
  const next = nextBusinessDay(addDays(day, 1))
  const at = next <= b.sim.window.until ? sastInstant(next, "10:00") : sastInstant(day, "16:30")
  return at.toISOString()
}

async function runStep(b: Breadth, spec: LeadSpec, who: LeadPerson, s: Step, day: string, key: string): Promise<void> {
  const c = await ownerClient(b, spec)
  const leadId = recall(b, `lead:${spec.key}`)
  const name = `${who.firstName} ${who.lastName}`
  if (typeof s === "object") {
    await c.patch(`/api/crm/leads/${leadId}/lost`, { reason: s.lost, notes: `Closed: ${s.lost.toLowerCase().replace(/_/g, " ")}.` })
    return
  }
  switch (s) {
    case "assign": {
      const ownerId = spec.owner === "officer2" ? (await as(b, "officer2")).user?.id : b.sim.actors.officer.user?.id
      await b.sim.actors.officer.patch(`/api/crm/leads/${leadId}`, { assignedToId: ownerId })
      return
    }
    case "call":
      await activity(c, leadId, "CALL", "Introductory call", `Spoke to ${name}: needs ${rands(spec.amountRands * 100)}, salaried, keen to proceed.`)
      await c.patch(`/api/crm/leads/${leadId}`, { status: "CONTACTED" })
      return
    case "no-answer":
      await activity(c, leadId, "CALL", "No answer", "Phone rang out; left a voicemail asking them to call back.")
      return
    case "callback":
      await c.patch(`/api/crm/leads/${leadId}/callback`, { callbackDate: followUp(b, day), callbackNotes: "Client asked to be called back with the documents list." })
      return
    case "task": {
      const t = await c.post<{ id: string }>("/api/agent-tasks", {
        entityType: "Lead", entityId: leadId, title: `Follow up with ${who.firstName}: payslip and bank statement`,
        priority: "MEDIUM", dueAt: followUp(b, day), assigneeId: c.user?.id,
      }, { expect: [201] })
      if (t.json?.id) remember(b, `task:${spec.key}`, t.json.id)
      return
    }
    case "task-done":
      await c.patch(`/api/agent-tasks/${recall(b, `task:${spec.key}`)}`, { status: "COMPLETED" })
      return
    case "qualify":
      await c.patch(`/api/crm/leads/${leadId}`, { status: "QUALIFIED", requestedAmount: spec.amountRands * 100, declaredIncome: who.incomeCents })
      await activity(c, leadId, "NOTE", "Qualified", `Net income ${rands(who.incomeCents)}; employer ${who.employerName}; within policy for ${rands(spec.amountRands * 100)}.`)
      return
    case "email": {
      const sent = await c.post<{ status: string }>(`/api/crm/leads/${leadId}/messages`, {
        channel: "EMAIL", subject: `Your loan enquiry with ${BRAND}`,
        text: `Hi ${who.firstName},\n\nThank you for your enquiry. To complete your application we need your latest payslip, three months' bank statements and a copy of your ID.\n\nKind regards,\n${c.user?.name ?? BRAND}`,
        operationId: operationId(key),
      }, { expect: [200] })
      if (sent.json?.status !== "SENT") throw new Error(`lead e-mail not accepted by the provider: ${sent.text.slice(0, 200)}`)
      return
    }
    case "proposal":
      await activity(c, leadId, "LOAN_OFFER", "Quote sent", `Indicative offer: ${rands(spec.amountRands * 100)} over 12 months, subject to affordability and a credit check.`)
      await c.patch(`/api/crm/leads/${leadId}`, { status: "PROPOSAL_SENT" })
      return
    case "meeting":
      await activity(c, leadId, "MEETING", "Branch visit", "Met at the branch to go through the options and the documents needed.")
      return
    case "convert": {
      const products = (await c.get<Array<{ id: string; code: string }>>("/api/products/loan")).json ?? []
      const product = products.find((row) => row.code === "PERSONAL")
      if (!product) throw new Error("no loan product PERSONAL")
      const res = await c.post<{ applicationId: string | null; applicationReference: string | null }>(`/api/crm/leads/${leadId}/convert`, {
        idNumber: who.idNumber, firstName: who.firstName, lastName: who.lastName, email: who.email, phone: who.phone,
        employmentStatus: "EMPLOYED", employerName: who.employerName,
        monthlyIncome: who.incomeCents / 100, monthlyExpenses: who.expensesCents / 100,
        productId: product.id, appliedAmount: spec.amountRands, appliedTermDays: 360,
        purpose: "Household expenses", loanPurposeCategory: "HOUSEHOLD",
      }, { expect: [200] })
      if (!res.json?.applicationId) throw new Error(`lead conversion returned no application: ${res.text.slice(0, 200)}`)
      log(`crm: lead ${spec.key} converted, application ${res.json.applicationReference}`)
    }
  }
}

export function scheduleCrm(b: Breadth): void {
  LEADS.forEach((spec, i) => {
    const who = leadPerson(spec, i)
    const day0 = "start" in spec.anchor ? fromStart(b, spec.anchor.start) : beforeEnd(b, spec.anchor.end)
    const base = `${String(9 + (i % 6)).padStart(2, "0")}:${String(5 + ((i * 7) % 45)).padStart(2, "0")}`
    const chain = `crm-${spec.key}`
    step(b, chain, "create", day0, base, async () => {
      remember(b, `lead:${spec.key}`, await createLead(b, spec, who))
    })
    let prevOffset = 0
    let at = base
    spec.path.forEach(([offset, s], k) => {
      at = offset === prevOffset ? later(at, 20) : later("09:40", (i * 11) % 120)
      prevOffset = offset
      const day = shiftBusinessDays(day0, offset)
      const name = `${String(k).padStart(2, "0")}-${typeof s === "object" ? "lost" : s}`
      step(b, chain, name, day, at, () => runStep(b, spec, who, s, day, `breadth:${chain}:${name}`))
    })
  })
}

/**
 * Follow-ups on the micro → personal-loan upsells the weekly cross-sell cron
 * raises (Opportunities screen, PATCH /api/crm/opportunities/[id]).
 */
export function scheduleOpportunityWork(b: Breadth): void {
  const moves: ReadonlyArray<readonly [number, string, string]> = [
    [30, "CONTACTED", "Called about moving to a personal loan; client will think it over."],
    [22, "CONTACTED", "Left a message about the personal-loan offer; will try again next week."],
    [15, "INTERESTED", "Interested in a personal loan once the current micro-loan is repaid."],
    [9, "DECLINED", "Not interested: does not want more credit at the moment."],
    [4, "INTERESTED", "Asked for an indicative quote on R15 000 over 24 months."],
  ]
  moves.forEach(([daysBefore, status, notes], k) => {
    step(b, "crm-opportunities", `move-${k}`, beforeEnd(b, daysBefore), "11:20", async () => {
      const c = await as(b, "officer2")
      const list = (await c.get<Array<{ id: string }>>("/api/crm/opportunities?type=PERSONAL_LOAN&status=PENDING")).json ?? []
      if (!list[0]) {
        log("crm: no pending personal-loan opportunity to work")
        return
      }
      await c.patch(`/api/crm/opportunities/${list[0].id}`, { status, notes, assignedToId: c.user?.id })
    })
  })
}
