/**
 * A funeral-cover sale the way the insurance officer (the FAIS representative)
 * does it on the quote screen — every step a route the screen calls:
 *
 *   quote (POST /api/insurance/quotes; priced from the ACTIVE card and screened
 *   against the insurer's terms → QUOTED) → FAIS record of advice (POST
 *   …/advice → ADVICE_RECORDED) → submitted to the insurer and accepted (PATCH
 *   …/status) → the FAIS disclosure presented to the client (POST …/disclosure,
 *   which renders the PDF and issues the one-time draft token) → bind (POST
 *   …/bind with that token; a standalone policy cannot exist without it).
 *
 * Claims (POST /api/insurance/claims, PATCH …/claims/[id]) and the advisor
 * commission the bind accrues (PATCH /api/insurance/commissions/[id]).
 */
import type { Persona } from "../personas"
import type { SimClient } from "../sim/api"
import { log } from "../sim/env"

export type Family = "single" | "couple" | "family" | "extended"

interface Life {
  ref: string
  clientId?: string
  firstName: string
  lastName: string
  idNumber?: string
  dateOfBirth: string
  relationship: string
  lifeType: "MAIN_MEMBER" | "SPOUSE" | "CHILD" | "EXTENDED_FAMILY"
  sumAssured: number
}

const yearsBefore = (dob: string, years: number): string => `${Number(dob.slice(0, 4)) + years}${dob.slice(4)}`

/** The covered lives: the client plus invented dependants (none of them clients). */
export function livesFor(p: Persona, clientId: string, family: Family, cover: number): Life[] {
  const spouseName = p.gender === "MALE" ? "Nomsa" : "Sizwe"
  const lives: Life[] = [{
    ref: "main", clientId, firstName: p.firstName, lastName: p.lastName, idNumber: p.idNumber,
    dateOfBirth: p.dateOfBirth, relationship: "Self", lifeType: "MAIN_MEMBER", sumAssured: cover,
  }]
  if (family !== "single") {
    lives.push({ ref: "spouse", firstName: spouseName, lastName: p.lastName, dateOfBirth: yearsBefore(p.dateOfBirth, 2),
      relationship: "Spouse", lifeType: "SPOUSE", sumAssured: cover })
  }
  if (family === "family" || family === "extended") {
    lives.push({ ref: "child-1", firstName: "Lesedi", lastName: p.lastName, dateOfBirth: "2015-03-14",
      relationship: "Daughter", lifeType: "CHILD", sumAssured: 10_000 })
    lives.push({ ref: "child-2", firstName: "Kamo", lastName: p.lastName, dateOfBirth: "2018-09-02",
      relationship: "Son", lifeType: "CHILD", sumAssured: 5_000 })
  }
  if (family === "extended") {
    lives.push({ ref: "parent", firstName: "Grace", lastName: p.lastName, dateOfBirth: "1957-06-21",
      relationship: "Mother", lifeType: "EXTENDED_FAMILY", sumAssured: 10_000 })
  }
  return lives
}

export interface QuoteResult {
  id: string
  quoteNumber: string
  status: string
  totalPremium: string | null
}

export async function createQuote(officer: SimClient, clientId: string, productId: string, lives: Life[]): Promise<QuoteResult> {
  const res = await officer.post<QuoteResult & { sellable: boolean }>("/api/insurance/quotes", { clientId, productId, lives }, { expect: [201] })
  const q = res.json
  if (!q?.id || q.status !== "QUOTED") throw new Error(`quote not priced: ${res.text.slice(0, 600)}`)
  return q
}

export interface Advice {
  decision: "ACCEPTED_RECOMMENDATION" | "CHOSE_ALTERNATIVE" | "DECLINED_ADVICE"
  needs: string
  recommendation: string
  reasonIfDifferent?: string
}

export async function recordAdvice(officer: SimClient, quoteId: string, a: Advice): Promise<void> {
  await officer.post(`/api/insurance/quotes/${quoteId}/advice`, {
    needsAnalysis: a.needs,
    productsConsidered: [
      { product: "Family Funeral Plan (Umoya Life)", reason: "Covers the client and dependants under one premium" },
      { product: "Individual funeral cover", reason: "Cheaper, but leaves the household's dependants uncovered" },
    ],
    recommendation: a.recommendation,
    clientDecision: a.decision,
    reasonIfDifferent: a.reasonIfDifferent ?? null,
  }, { expect: [200, 201] })
}

export const setQuoteStatus = (officer: SimClient, quoteId: string, status: string): Promise<unknown> =>
  officer.patch(`/api/insurance/quotes/${quoteId}/status`, { status })

/** Disclosure presented to the client, then the bind that needs its token. Returns the policy id. */
export async function discloseAndBind(officer: SimClient, quoteId: string): Promise<string> {
  const disclosure = await officer.post<{ draftToken: string }>(`/api/insurance/quotes/${quoteId}/disclosure`, {}, { expect: [201] })
  const draftToken = disclosure.json?.draftToken
  if (!draftToken) throw new Error(`disclosure issued no token: ${disclosure.text.slice(0, 300)}`)
  const bound = await officer.post<{ policyId: string; policyNumber: string }>(`/api/insurance/quotes/${quoteId}/bind`, { draftToken }, { expect: [200, 201] })
  if (!bound.json?.policyId) throw new Error(`bind returned no policy: ${bound.text.slice(0, 300)}`)
  log(`insurance: quote ${quoteId} bound as policy ${bound.json.policyNumber}`)
  return bound.json.policyId
}

export async function submitClaim(officer: SimClient, policyId: string, c: { amount: number; type: string; incidentDate: string; notes: string }): Promise<string> {
  const res = await officer.post<{ id: string; claimNumber: string }>("/api/insurance/claims", {
    policyId, claimAmount: c.amount, claimType: c.type, incidentDate: c.incidentDate, fnolDate: c.incidentDate, notes: c.notes,
  }, { expect: [201] })
  if (!res.json?.id) throw new Error(`claim create returned no id: ${res.text.slice(0, 300)}`)
  log(`insurance: claim ${res.json.claimNumber} submitted`)
  return res.json.id
}

export const updateClaim = (officer: SimClient, claimId: string, body: Record<string, unknown>): Promise<unknown> =>
  officer.patch(`/api/insurance/claims/${claimId}`, body)

interface CommissionRow {
  id: string
  policyId: string | null
  status: string
}

/** Approves (and optionally pays) the advisor commissions accrued by the given policies (ADMIN). */
export async function settleCommissions(admin: SimClient, policyIds: string[], pay: boolean): Promise<number> {
  const list = (await admin.get<CommissionRow[]>("/api/insurance/commissions")).json ?? []
  let n = 0
  for (const c of list.filter((r) => r.policyId && policyIds.includes(r.policyId))) {
    if (c.status === "PENDING") {
      await admin.patch(`/api/insurance/commissions/${c.id}`, { action: "approve" })
      n++
    }
    if (pay && (c.status === "PENDING" || c.status === "APPROVED")) await admin.patch(`/api/insurance/commissions/${c.id}`, { action: "pay" })
  }
  return n
}
