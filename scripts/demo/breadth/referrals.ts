/**
 * Referral agents (CRM → Agent Hub), through the hub's routes:
 *
 *   - agents with their codes (POST /api/agent-hub/agents, LOAN_ADMIN), one with
 *     a negotiated rate (PATCH /api/agent-hub/agents/[id] commissionBps);
 *   - borrowers an agent brought in: the collections manager sets the agent on
 *     the client record right after capture (the client Edit form's referral
 *     field, PUT /api/clients/[id] — LOAN_ADMIN), so the payout accrues the
 *     agent's commission (a CONVERTED referral event, PENDING);
 *   - website applications carrying a code (breadth/crm-leads.ts, origin
 *     "website-apply") log WEBSITE_APPLICATION events;
 *   - month-end commission review by the branch manager: commission on a loan
 *     whose first instalment has been paid becomes PAYABLE, website leads are
 *     quality-flagged (PATCH /api/agent-hub/referral-events/[id], with the
 *     decision note the route demands). The hub screen lists the events; the
 *     simulator reads the same rows read-only.
 */
import { log } from "../sim/env"
import { readDb } from "../sim/readonly-db"
import { as, beforeEnd, clientOf, fromStart, recall, recallOptional, remember, step, type Breadth } from "./context"

const AGENTS = [
  { code: "TSHEPO-FLD", displayName: "Tshepo Baloyi (field agent)", legalName: "Tshepo Baloyi", channel: "FIELD", phone: "+27600030001",
    email: "tshepo.baloyi@agents.invalid", label: "Mamelodi taxi rank", campaign: "Field 2026", bps: 250 },
  { code: "SOWETO-CP", displayName: "Soweto Community Partners", legalName: "Soweto Community Partners NPC", channel: "FIELD", phone: "+27600030002",
    email: "partners@soweto-cp.invalid", label: "Community centre desk", campaign: "Partners 2026", bps: null },
  { code: "FB-WINTER26", displayName: "Winter social campaign", legalName: "Brightline Digital (Pty) Ltd", channel: "SOCIAL", phone: "+27600030003",
    email: "accounts@brightline.invalid", label: "Facebook winter ads", campaign: "Winter 2026", bps: null },
] as const

/** Borrowers attributed to an agent at capture: [persona, agent code]. */
export const REFERRED: ReadonlyArray<readonly [string, string]> = [
  ["bg-07", "TSHEPO-FLD"], ["bg-11", "SOWETO-CP"], ["bg-10", "TSHEPO-FLD"], ["bg-12", "FB-WINTER26"],
  ["bg-20", "SOWETO-CP"], ["bg-17", "TSHEPO-FLD"], ["bg-14", "FB-WINTER26"],
]

interface CreatedAgent {
  agent: { id: string }
  referralCode: { id: string }
}

async function ensureAgents(b: Breadth): Promise<void> {
  const loanAdmin = b.sim.actors.loanAdmin
  for (const a of AGENTS) {
    if (recallOptional(b, `agent:${a.code}`)) continue
    const res = await loanAdmin.post<CreatedAgent>("/api/agent-hub/agents", {
      displayName: a.displayName, legalName: a.legalName, channel: a.channel, phone: a.phone, email: a.email,
      code: a.code, label: a.label, campaign: a.campaign, notes: "Signed agent agreement on file.",
    }, { expect: [201] })
    if (!res.json?.agent.id) throw new Error(`agent ${a.code} create returned no id`)
    remember(b, `agent:${a.code}`, res.json.agent.id)
    remember(b, `code:${a.code}`, res.json.referralCode.id)
    if (a.bps !== null) await loanAdmin.patch(`/api/agent-hub/agents/${res.json.agent.id}`, { commissionBps: a.bps })
    log(`agent hub: ${a.displayName} (${a.code})`)
  }
}

async function attribute(b: Breadth, personaId: string, code: string): Promise<void> {
  const clientId = clientOf(b, personaId)
  const loanAdmin = b.sim.actors.loanAdmin
  const client = (await loanAdmin.get<{ updatedAt: string }>(`/api/clients/${clientId}`)).json
  if (!client?.updatedAt) throw new Error(`GET /api/clients/${clientId} returned no revision`)
  await loanAdmin.put(`/api/clients/${clientId}`, { expectedUpdatedAt: client.updatedAt, referralCodeId: recall(b, `code:${code}`) })
  log(`agent hub: ${personaId} attributed to ${code}`)
}

interface EventRow {
  id: string
  eventType: string
  loanId: string | null
}

async function reviewCommissions(b: Breadth): Promise<void> {
  const manager = await as(b, "branchManager")
  const events = await readDb().$queryRawUnsafe<EventRow[]>(`
    SELECT e.id, e."eventType", e.metadata->>'loanId' AS "loanId" FROM "ReferralEvent" e
    WHERE (e."eventType" = 'CONVERTED' AND e."commissionStatus" = 'PENDING')
       OR (e."eventType" = 'WEBSITE_APPLICATION' AND e."qualityFlag" IS NULL)
    ORDER BY e."createdAt"`)
  let decided = 0
  for (const e of events) {
    if (e.eventType === "WEBSITE_APPLICATION") {
      await manager.patch(`/api/agent-hub/referral-events/${e.id}`, { qualityFlag: "APPROVED", decisionNote: "Genuine applicant; contact details verified by phone." })
      decided++
      continue
    }
    const [paid] = await readDb().$queryRawUnsafe<Array<{ n: bigint }>>(
      `SELECT count(*) AS n FROM "RepaymentSchedule" WHERE "loanId" = $1 AND "installmentNo" = 1 AND status = 'PAID'`, e.loanId)
    if (!paid || Number(paid.n) === 0) continue
    await manager.patch(`/api/agent-hub/referral-events/${e.id}`, { commissionStatus: "PAYABLE", decisionNote: "First instalment received; commission approved for the month-end run." })
    decided++
  }
  log(`agent hub: ${decided} referral decision(s)`)
}

export function scheduleReferrals(b: Breadth): void {
  step(b, "referral-agents", "agents", fromStart(b, 0), "08:20", () => ensureAgents(b))
  for (const [personaId, code] of REFERRED) {
    const plan = b.sim.plans.get(personaId)
    if (!plan) throw new Error(`referral plan names unknown persona ${personaId}`)
    // Between client capture (09:00) and the application's submission (09:20).
    step(b, `referral-${personaId}`, "attribute", plan.originationStart, "09:10", () => attribute(b, personaId, code))
  }
  for (const daysBefore of [85, 43, 3]) {
    step(b, "referral-review", `review-${daysBefore}`, beforeEnd(b, daysBefore), "15:30", () => reviewCommissions(b))
  }
}
