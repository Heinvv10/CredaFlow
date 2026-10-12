/**
 * Step 1 — capture. A credit officer captures the persona as a client (the
 * staff client wizard, POST /api/clients) and submits the loan application
 * (the staff application wizard, POST /api/applications with
 * submitForReview). The borrower then activates the client portal (POST
 * /api/portal/register, request code + verify) and signs in: the portal is
 * where they upload documents, acknowledge the PASQ, sign the agreement and
 * sign the debit mandate.
 *
 * Staff capture is the product's primary channel: debit-mandate signing is
 * portal-only, and the portal can only be activated for a client that
 * already exists, so a self-service consumer still starts as a client record.
 */
import { calculateLoan } from "../../../lib/loan-calculator"
import { deriveAffordabilityFlag } from "../../../lib/validation/application-wizard"
import type { Persona } from "../personas"
import { SimClient } from "../sim/api"
import { log } from "../sim/env"
import { now } from "../sim/clock"
import type { OriginationContext } from "./context"
import { readActivationCode } from "./inbox"

interface ProductRow {
  id: string
  code: string
  productType: string | null
  interestRatePm: number
  interestModel: "FLAT" | "REDUCING_BALANCE" | "DAILY_ACCRUAL"
  initiationFeeModel: "FLAT_PCT" | "NCA_REG42"
  initiationFeePct: number
  initiationFeeMax: number
  monthlyServiceFee: number
}

export interface CreatedApplication {
  id: string
  reference: string
  status: string
}

const rands = (cents: number): string => (cents / 100).toFixed(2)

/** The client wizard's payload (components/clients/wizard/types.ts). */
function clientWizardData(p: Persona): Record<string, unknown> {
  const e = p.expenses
  return {
    firstName: p.firstName,
    lastName: p.lastName,
    idNumber: p.idNumber,
    dateOfBirth: p.dateOfBirth,
    gender: p.gender,
    email: p.email,
    phone: p.phone,
    whatsapp: p.phone,
    ...p.address,
    employmentStatus: p.employment.employmentStatus,
    incomeSourceType: p.employment.incomeSourceType,
    employerName: p.employment.employerName,
    employerAddress: p.employment.employerAddress,
    employmentStartDate: p.employment.employmentStartDate,
    salaryPaymentDay: String(p.employment.salaryPaymentDay),
    monthlyIncome: rands(p.payroll.netCents),
    grossMonthlyIncome: rands(p.payroll.grossCents),
    expenseBreakdown: {
      housing: rands(e.housing),
      transport: rands(e.transport),
      food: rands(e.food),
      education: rands(e.education),
      insurance: rands(e.insurance),
      clothing: rands(e.clothing),
      entertainment: rands(e.entertainment),
      medical: rands(e.medical),
      other: rands(e.other),
      belowMleJustification: "",
    },
    debtObligations: p.debts.map((d) => ({
      creditProvider: d.creditProvider,
      accountType: d.accountType,
      outstandingBalance: rands(d.outstandingBalanceCents),
      monthlyInstalment: rands(d.monthlyInstalmentCents),
      notes: "",
    })),
    bankName: p.bank.bankCode,
    bankAccountNumber: p.bank.accountNumber,
    bankBranchCode: p.bank.branchCode,
    accountType: p.bank.accountType,
    nextOfKinName: p.nextOfKin.name,
    nextOfKinPhone: p.nextOfKin.phone,
    nextOfKinRelationship: p.nextOfKin.relationship,
    popiaConsentGiven: true,
  }
}

export async function captureClient(ctx: OriginationContext, p: Persona): Promise<string> {
  const res = await ctx.officer.post<{ id: string; reference: string }>("/api/clients", clientWizardData(p))
  const client = res.json
  if (!client?.id) throw new Error(`POST /api/clients returned no client id: ${res.text.slice(0, 300)}`)
  log(`${p.id}: client ${client.reference} captured`)
  return client.id
}

/**
 * The application wizard's step-3 snapshot is computed in the browser
 * (Step3Affordability) from the same calculator; the server recomputes and
 * stores its own evidence, but refuses a submission without the flag.
 */
function wizardAffordability(p: Persona, product: ProductRow) {
  const calc = calculateLoan({
    principal: p.loanRequest.amountCents,
    termDays: p.loanRequest.termDays,
    interestRatePm: product.interestRatePm,
    productType: product.productType,
    interestModel: product.interestModel,
    initiationFeeModel: product.initiationFeeModel,
    initiationFeePct: product.initiationFeePct,
    initiationFeeMax: product.initiationFeeMax,
    monthlyServiceFee: product.monthlyServiceFee,
  })
  const expenses = Object.values(p.expenses).reduce((sum, cents) => sum + cents, 0)
  const debt = p.debts.reduce((sum, d) => sum + d.monthlyInstalmentCents, 0)
  const ndi = p.payroll.netCents - expenses - debt
  const flag = ndi <= 0 ? "FAIL" : deriveAffordabilityFlag((100 * calc.monthlyInstalment) / ndi)
  return {
    monthlyInstalment: String(calc.monthlyInstalment),
    firstInstalment: String(calc.schedule[0]?.totalDue ?? calc.monthlyInstalment),
    totalInterest: String(calc.totalInterest),
    initiationFee: String(calc.initiationFee),
    serviceFees: String(calc.serviceFees),
    totalRepayable: String(calc.totalRepayable),
    affordabilityFlag: flag,
    // The wizard demands this acknowledgement before a FAIL can proceed and
    // records it as the reckless-lending assessment at submission.
    recklessLendingConfirmed: flag === "FAIL",
  }
}

/** `submit: false` saves the wizard as a DRAFT (the "Save draft" button) instead of submitting it. */
export async function submitApplication(
  ctx: OriginationContext,
  p: Persona,
  clientId: string,
  submit = true,
): Promise<CreatedApplication> {
  const products = (await ctx.officer.get<ProductRow[]>("/api/products/loan")).json ?? []
  const product = products.find((row) => row.code === p.loanRequest.productCode)
  if (!product) throw new Error(`no loan product ${p.loanRequest.productCode}`)

  const res = await ctx.officer.post<CreatedApplication>("/api/applications", {
    clientId,
    productId: product.id,
    appliedAmount: p.loanRequest.amountCents,
    appliedTermDays: p.loanRequest.termDays,
    purpose: p.debts.length > 2 ? "Consolidate store and card accounts" : "Household expenses and repairs",
    purposeDetails: "",
    loanPurposeCategory: p.debts.length > 2 ? "DEBT_CONSOLIDATION" : "HOUSEHOLD",
    ...wizardAffordability(p, product),
    // No credit-life product is configured for the tenant, so the wizard shows
    // no election block and the server records the no-offer disclosure.
    creditLifeElection: "",
    creditLifeDisclosureAcknowledged: false,
    pasqAcknowledged: true,
    affordabilityDeclared: true,
    submitForReview: submit,
  })
  const app = res.json
  const expected = submit ? "SUBMITTED" : "DRAFT"
  if (!app?.id || app.status !== expected) {
    throw new Error(`POST /api/applications did not end ${expected}: ${res.text.slice(0, 300)}`)
  }
  log(`${p.id}: application ${app.reference} ${expected}`)
  return app
}

/** Portal activation (request a code, read it from the inbox, set a password), then sign in. */
export async function activatePortal(p: Persona, password: string): Promise<SimClient> {
  const portal = new SimClient()
  const requestedAt = now()
  await portal.post("/api/portal/register", { email: p.email, idNumber: p.idNumber })
  const otp = await readActivationCode(p.email, requestedAt)
  await portal.post("/api/portal/register", {
    email: p.email,
    idNumber: p.idNumber,
    otp,
    password,
    confirmPassword: password,
  })
  await portal.loginClient(p.email, password)
  log(`${p.id}: portal activated and signed in`)
  return portal
}
