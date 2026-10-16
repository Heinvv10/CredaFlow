/**
 * The insurance desk's storylines (see insurance-catalogue.ts and
 * insurance-sales.ts for the routes): the catalogue goes live two weeks in;
 * the insurance officer then sells funeral cover to borrowers a week or two
 * after their payout, from the opportunity the credit officer logged at the
 * payout call (the cross-sell cron raises only loan and credit-life upsells) —
 * with one client choosing a cheaper alternative (re-quoted), one declining
 * the advice, one quote still awaiting the client; a claim runs to payment and
 * another is freshly lodged; the advisor commission each bind accrues is
 * approved and paid a month later by the admin.
 */
import { getPersona } from "../personas"
import { log } from "../sim/env"
import { shiftBusinessDays } from "../simulate/dates"
import { afterOrigination, as, beforeEnd, clientOf, fromStart, recall, recallOptional, remember, step, type Breadth } from "./context"
import { ensureFuneralCatalogue } from "./insurance-catalogue"
import {
  createQuote, discloseAndBind, livesFor, recordAdvice, setQuoteStatus, settleCommissions, submitClaim, updateClaim,
  type Advice, type Family,
} from "./insurance-sales"

interface Sale {
  personaId: string
  /** Business days after origination day 0 (payout is day 3). */
  after: number
  family: Family
  cover: number
  outcome: "bound" | "alternative" | "declined" | "awaiting"
}

export const SALES: readonly Sale[] = [
  { personaId: "bg-11", after: 10, family: "extended", cover: 20_000, outcome: "bound" },
  { personaId: "bg-16", after: 12, family: "couple", cover: 10_000, outcome: "bound" },
  { personaId: "bg-10", after: 9, family: "family", cover: 30_000, outcome: "alternative" },
  { personaId: "bg-12", after: 8, family: "single", cover: 20_000, outcome: "declined" },
  { personaId: "bg-17", after: 8, family: "family", cover: 20_000, outcome: "bound" },
  { personaId: "bg-14", after: 6, family: "couple", cover: 20_000, outcome: "awaiting" },
]

const NEEDS = "Household relies on the client's salary; no funeral cover in place apart from a small burial-society share."

const advice = (s: Sale): Advice => {
  const recommendation = `Family Funeral Plan, R${s.cover.toLocaleString("en-ZA")} on the main member, covering the household.`
  if (s.outcome === "alternative") return { decision: "CHOSE_ALTERNATIVE", needs: NEEDS, recommendation, reasonIfDifferent: "Premium too high for the budget; client chose R10 000 cover on herself only." }
  if (s.outcome === "declined") return { decision: "DECLINED_ADVICE", needs: NEEDS, recommendation, reasonIfDifferent: "Client is covered by an employer group funeral scheme." }
  return { decision: "ACCEPTED_RECOMMENDATION", needs: NEEDS, recommendation }
}

const productId = (b: Breadth): string => recall(b, "funeral-product")

/**
 * The FUNERAL_COVER opportunity the credit officer logged at payout (POST
 * /api/crm/opportunities). Opportunities are CRM records (CREDIT_OFFICER and
 * up), so the credit officer moves it as the insurance desk reports back.
 */
async function moveOpportunity(b: Breadth, personaId: string, status: string, notes: string): Promise<void> {
  await b.sim.actors.officer.patch(`/api/crm/opportunities/${recall(b, `opportunity:${personaId}`)}`, { status, notes })
}

function scheduleSale(b: Breadth, s: Sale): void {
  const chain = `insurance-${s.personaId}`
  const day0 = afterOrigination(b, s.personaId, s.after)
  // At the payout call the client says the household has no funeral cover.
  step(b, chain, "opportunity", afterOrigination(b, s.personaId, 4), "15:40", async () => {
    const officer = b.sim.actors.officer
    const res = await officer.post<{ id: string }>("/api/crm/opportunities", {
      clientId: clientOf(b, s.personaId), type: "FUNERAL_COVER", assignedToId: officer.user?.id,
      notes: "Mentioned at the payout call: no funeral cover for the household. Referred to the insurance desk.",
    }, { expect: [201] })
    if (!res.json?.id) throw new Error(`opportunity create returned no id: ${res.text.slice(0, 200)}`)
    remember(b, `opportunity:${s.personaId}`, res.json.id)
  })
  step(b, chain, "quote-advice", day0, "11:00", async () => {
    const officer = await as(b, "insurance")
    const p = getPersona(s.personaId)
    const clientId = clientOf(b, s.personaId)
    const q = await createQuote(officer, clientId, productId(b), livesFor(p, clientId, s.family, s.cover))
    remember(b, `${chain}:quote`, q.id)
    await moveOpportunity(b, s.personaId, "INTERESTED", `Quoted ${q.quoteNumber}: R${q.totalPremium}/month.`)
    if (s.outcome === "awaiting") return
    await recordAdvice(officer, q.id, advice(s))
    if (s.outcome === "declined") {
      await setQuoteStatus(officer, q.id, "REJECTED")
      await moveOpportunity(b, s.personaId, "DECLINED", "Declined the advice: already covered by an employer scheme.")
      return
    }
    if (s.outcome === "alternative") {
      await setQuoteStatus(officer, q.id, "REJECTED")
      const alt = await createQuote(officer, clientId, productId(b), livesFor(p, clientId, "single", 10_000))
      remember(b, `${chain}:quote`, alt.id)
      await recordAdvice(officer, alt.id, { decision: "ACCEPTED_RECOMMENDATION", needs: NEEDS, recommendation: "Re-quoted at R10 000 on the main member, within budget." })
    }
    await setQuoteStatus(officer, recall(b, `${chain}:quote`), "SUBMITTED_TO_INSURER")
  })
  if (s.outcome === "awaiting" || s.outcome === "declined") return
  step(b, chain, "accept-bind", shiftBusinessDays(day0, 2), "10:20", async () => {
    const officer = await as(b, "insurance")
    const quoteId = recall(b, `${chain}:quote`)
    await setQuoteStatus(officer, quoteId, "ACCEPTED")
    remember(b, `${chain}:policy`, await discloseAndBind(officer, quoteId))
    await moveOpportunity(b, s.personaId, "CONVERTED", "Family Funeral Plan bound.")
  })
  step(b, chain, "commission", shiftBusinessDays(day0, 22), "15:20", async () => {
    const n = await settleCommissions(b.sim.actors.admin, [recall(b, `${chain}:policy`)], true)
    log(`insurance: ${n} advisor commission(s) approved and paid for ${s.personaId}`)
  })
}

/**
 * The first claim's life after lodging, [business-day offset, PATCH body], in
 * order. PAID only through its own action (PATCH /api/insurance/claims/[id]);
 * the note is a plain edit. scripts/demo/breadth/insurance-claim.test.ts runs
 * these bodies through the route.
 */
export const CLAIM_1_UPDATES: ReadonlyArray<readonly [number, Record<string, unknown>]> = [
  [2, { status: "UNDER_REVIEW", notes: "Documents sent to Umoya Life claims." }],
  [7, { action: "approve", approvedAmount: 10_000, insurerRef: "UML-CLM-26-0412" }],
  [9, { action: "mark_paid" }],
  [9, { notes: "Insurer paid R10 000 to the beneficiary." }],
]

function scheduleClaims(b: Breadth): void {
  // The insured mother on bg-11's extended-family policy, after the 90-day waiting period.
  const bound = shiftBusinessDays(afterOrigination(b, "bg-11", 10), 2)
  const claimDay = shiftBusinessDays(bound, 70)
  const chain = "insurance-claim-1"
  step(b, chain, "lodge", claimDay, "10:40", async () => {
    const id = await submitClaim(await as(b, "insurance"), recall(b, "insurance-bg-11:policy"), {
      amount: 10_000, type: "DEATH", incidentDate: shiftBusinessDays(claimDay, -3),
      notes: "Insured mother passed away at home (natural causes). Death certificate and BI-1663 received.",
    })
    remember(b, chain, id)
  })
  CLAIM_1_UPDATES.forEach(([offset, body], k) => {
    step(b, chain, `update-${k}`, shiftBusinessDays(claimDay, offset), "11:30", async () => {
      await updateClaim(await as(b, "insurance"), recall(b, chain), body)
    })
  })
  step(b, "insurance-claim-2", "lodge", beforeEnd(b, 2), "14:35", async () => {
    const policyId = recallOptional(b, "insurance-bg-16:policy")
    if (!policyId) throw new Error("bg-16 has no bound policy to claim on")
    await submitClaim(await as(b, "insurance"), policyId, {
      amount: 10_000, type: "DEATH", incidentDate: beforeEnd(b, 5), notes: "Spouse died in a road accident; claim form and police report received.",
    })
  })
}

export function scheduleInsurance(b: Breadth): void {
  step(b, "insurance-catalogue", "setup", fromStart(b, 9), "09:50", async () => {
    await ensureFuneralCatalogue(b, b.sim.actors.admin, await as(b, "insurance"))
  })
  for (const s of SALES) scheduleSale(b, s)
  scheduleClaims(b)
}
