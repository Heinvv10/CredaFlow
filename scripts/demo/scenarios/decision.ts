/**
 * Steps 4–6 — bureau, affordability, decision.
 *
 * Bureau: starting the review (POST …/review) moves SUBMITTED → UNDER_REVIEW
 * and runs the Experian enquiry for that review generation (simulated in the
 * sim, EXPERIAN_DRY_RUN). It refuses unless the four core documents are
 * verified with no unresolved mismatch.
 *
 * Affordability: the officer re-confirms the declared debts on the
 * application (PATCH …/affordability, as AffordabilityCapture does) and the
 * server recomputes NDI; an admin records the reckless-lending assessment and
 * the consumer's affordability declaration (PATCH …/compliance).
 *
 * Credit checks (lib/credit-checks): every flag the evidence checks raise must
 * be cleared with a reason before approval. The specimens are generated, so
 * the document-authenticity check flags their statements; the admin reads the
 * flags (GET …/checks, which recomputes them) and clears each one.
 *
 * Decision (POST …/decide, multipart, LOAN_ADMIN): approve for debit-order
 * repayment, or decline. A persona meant to decline must be refused by the
 * product, not by the script: the approval is attempted and must come back
 * 422 from the affordability gate before the decline is recorded.
 */
import type { Persona } from "../personas"
import { log } from "../sim/env"
import type { OriginationContext } from "./context"

interface ClientDebtRow {
  id: string
  creditProvider: string
  accountType: string
  outstandingBalance: number
  monthlyInstalment: number
  notes: string | null
}

export interface ReviewResult {
  status: string
  bureauResult: string
}

export interface AffordabilityResult {
  netDisposableIncome: number
  affordabilityNDI: number
  isAffordable: boolean
}

export type Decision = "approve" | "decline"

interface CheckFlag {
  id: string
  check: string
  code: string
  status: string
}

function clearReason(f: CheckFlag): string {
  return f.check === "DOCUMENT_AUTHENTICITY"
    ? "Statement is a demo specimen generated for this sample application, not a bank original; figures checked against the payslips."
    : `Reviewed ${f.check} (${f.code}) against the payslips, bank statement and bureau report; no concern for this application.`
}

async function clearCreditChecks(ctx: OriginationContext, p: Persona, applicationId: string): Promise<void> {
  const view = (await ctx.admin.get<{ flags: CheckFlag[] }>(`/api/applications/${applicationId}/checks`)).json
  if (!view) throw new Error(`GET /api/applications/${applicationId}/checks returned no JSON`)
  const open = view.flags.filter((f) => f.status === "OPEN")
  for (const f of open) {
    await ctx.admin.post(`/api/applications/${applicationId}/checks/${f.id}/clear`, { reason: clearReason(f) }, { expect: [200] })
  }
  if (open.length > 0) log(`${p.id}: cleared ${open.length} credit check(s): ${open.map((f) => `${f.check}/${f.code}`).join(", ")}`)
}

export async function startReview(ctx: OriginationContext, applicationId: string): Promise<ReviewResult> {
  const res = await ctx.officer.post<ReviewResult>(`/api/applications/${applicationId}/review`)
  const review = res.json
  if (review?.status !== "UNDER_REVIEW") throw new Error(`review did not start: ${res.text.slice(0, 300)}`)
  // "skipped" means no bureau consent; "failed" means the enquiry errored.
  // Either leaves approval without NCA s.81 evidence.
  if (review.bureauResult !== "stored") {
    throw new Error(`bureau enquiry result "${review.bureauResult}" — approval would have no bureau evidence`)
  }
  log(`review started; bureau ${review.bureauResult}`)
  return review
}

export async function assessAffordability(
  ctx: OriginationContext,
  clientId: string,
  applicationId: string,
): Promise<AffordabilityResult> {
  const client = (await ctx.officer.get<{ debtObligations: ClientDebtRow[] }>(`/api/clients/${clientId}`)).json
  if (!client) throw new Error(`GET /api/clients/${clientId} returned no JSON`)
  const res = await ctx.officer.patch<AffordabilityResult>(`/api/applications/${applicationId}/affordability`, {
    existingDebtObligations: client.debtObligations.map((d) => ({
      sourceId: d.id,
      creditor: d.creditProvider,
      type: d.accountType,
      monthlyInstalment: d.monthlyInstalment,
      balance: d.outstandingBalance,
      notes: d.notes,
    })),
  })
  const result = res.json
  if (!result) throw new Error("affordability returned no JSON")
  log(`affordability NDI ${result.netDisposableIncome / 100} → after loan ${result.affordabilityNDI / 100}; affordable=${result.isAffordable}`)

  await ctx.admin.patch(`/api/applications/${applicationId}/compliance`, {
    recklessLendingAssessed: true,
    recklessLendingNote: result.isAffordable
      ? "Bureau, payslips and bank statement reviewed; instalment within NDI after declared obligations."
      : "Bureau, payslips and bank statement reviewed; declared obligations leave insufficient NDI for the instalment.",
    clientAffordabilityDeclared: true,
  })
  return result
}

function decideForm(fields: Record<string, string>): FormData {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.set(k, v)
  return form
}

export async function decide(
  ctx: OriginationContext,
  p: Persona,
  applicationId: string,
  decision: Decision,
  affordability: AffordabilityResult,
): Promise<"APPROVED" | "DECLINED"> {
  const path = `/api/applications/${applicationId}/decide`
  await clearCreditChecks(ctx, p, applicationId)
  if (decision === "approve") {
    if (!affordability.isAffordable) throw new Error(`${p.id}: approval requested but the assessment found it unaffordable`)
    await ctx.admin.post(path, decideForm({ action: "approve", repaymentMethod: "DEBIT_ORDER" }), { expect: [200] })
    log(`${p.id}: APPROVED (debit order)`)
    return "APPROVED"
  }

  if (affordability.isAffordable) throw new Error(`${p.id}: decline requested but the assessment found it affordable`)
  const refused = await ctx.admin.post<{ error?: string }>(
    path,
    decideForm({ action: "approve", repaymentMethod: "DEBIT_ORDER" }),
    { expect: [422] },
  )
  const reason = refused.json?.error ?? ""
  if (!reason.startsWith("Affordability gate")) throw new Error(`${p.id}: approval refused for another reason: ${reason}`)
  log(`${p.id}: approval refused by the product — ${reason}`)

  await ctx.admin.post(path, decideForm({
    action: "decline",
    declineCategory: "AFFORDABILITY",
    reason: "Your existing monthly credit obligations leave too little disposable income for this instalment.",
  }), { expect: [200] })
  log(`${p.id}: DECLINED (affordability)`)
  return "DECLINED"
}
