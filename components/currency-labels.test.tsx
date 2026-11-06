// @vitest-environment jsdom
import { renderToStaticMarkup } from "react-dom/server"
import type { ReactElement } from "react"
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { resetActiveJurisdiction, setActiveJurisdiction } from "@/lib/jurisdiction/active"
import { EMPTY_CLIENT_WIZARD_DATA } from "@/components/clients/wizard/types"
import { ExpenseBreakdownSection } from "@/components/clients/ExpenseBreakdownSection"
import { DebtObligationsSection } from "@/components/clients/DebtObligationsSection"
import { Step3Employment } from "@/components/clients/wizard/Step3Employment"
import { ClientForm } from "@/components/clients/ClientFormLegacy"
import { LoanCalculator } from "@/components/applications/LoanCalculator"
import { Step2LoanParams } from "@/components/applications/wizard/Step2LoanParams"
import { AffordabilityCapture } from "@/components/applications/AffordabilityCapture"
import { ConvertLeadForm } from "@/components/crm/ConvertLeadForm"
import { QuickPaymentCapture } from "@/components/payments/QuickPaymentCapture"
import { NonNcaArrearsFields } from "@/components/products/NonNcaArrearsFields"
import { LoanProductForm } from "@/components/products/LoanProductForm"
import { ArrangementForm } from "@/components/collections/ArrangementForm"
import { LogContactButton } from "@/components/collections/LogContactButton"
import { ExploreCalculator } from "@/app/(portal)/portal/apply/ExploreCalculator"
import { ManualPaymentForm } from "@/components/portal/ManualPaymentForm"
import { ClientNotifiedPayments } from "@/components/payments/ClientNotifiedPayments"
import { LeadEditForm } from "@/components/crm/LeadEditForm"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

afterEach(() => resetActiveJurisdiction())

const PRODUCT = {
  id: "p1", code: "P1", name: "Personal", productType: "PERSONAL", minAmount: 100000, maxAmount: 5000000,
  minTermDays: 30, maxTermDays: 360, interestRatePm: 5, interestModel: "FLAT" as const,
  initiationFeeModel: "FLAT_PCT" as const, initiationFeePct: 10, initiationFeeMax: 100000, monthlyServiceFee: 6000,
}

const EXPENSES = { housing: 0, transport: 0, food: 0, education: 0, insurance: 0, clothing: 0, entertainment: 0, medical: 0, other: 0 }
const DEBT = { creditorName: "Demo Bank", accountType: "PERSONAL_LOAN", outstandingBalance: 1, monthlyInstalment: 1 }


const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("")

/** Mounts `element`, presses each named button in turn, and returns the text on screen afterwards. */
function textAfterPressing(element: ReactElement, ...buttons: string[]): string {
  let renderer!: ReactTestRenderer
  act(() => { renderer = create(element) })
  for (const name of buttons) {
    const button = renderer.root.findAllByType("button").find((b) => text(b).includes(name))
    if (!button) throw new Error(`no button "${name}"`)
    act(() => button.props.onClick())
  }
  return text(renderer.root)
}

const CASES: [string, () => ReactElement][] = [
  ["ExpenseBreakdownSection", () => <ExpenseBreakdownSection data={EXPENSES} onChange={() => {}} />],
  ["DebtObligationsSection", () => <DebtObligationsSection debts={[DEBT as never]} onChange={() => {}} />],
  ["Step3Employment", () => (
    <Step3Employment data={{ ...EMPTY_CLIENT_WIZARD_DATA, employmentStatus: "EMPLOYED", hasDebtObligations: true, debtObligations: [{ ...DEBT }] } as never} patch={() => {}} errors={{}} mode="staff" />
  )],
  ["ClientFormLegacy", () => <ClientForm initialData={{ firstName: "A", lastName: "B", idNumber: "1", email: "a@x.invalid", phone: "1", monthlyIncome: 1, monthlyExpenses: 1 }} />],
  ["LoanCalculator", () => <LoanCalculator products={[PRODUCT]} initialProductId="p1" initialAmount={100000} initialTerm={60} />],
  ["Step2LoanParams", () => <Step2LoanParams data={{ productId: "p1" } as never} patch={() => {}} errors={{}} mode="staff" products={[PRODUCT] as never} />],
  ["AffordabilityCapture", () => (
    <AffordabilityCapture applicationId="a1" monthlyIncome={1_500_000} monthlyExpenses={800_000}
      existingDebts={[{ creditor: "Demo Bank", type: "PERSONAL_LOAN", monthlyInstalment: 1, balance: 1 }] as never} clientDebtTotal={0} proposedInstalment={200_000} done={false} />
  )],
  ["NonNcaArrearsFields", () => <NonNcaArrearsFields values={{ marginPercent: "", feeRand: "" }} onChange={() => {}} />],
  ["LoanProductForm", () => <LoanProductForm />],
  ["ArrangementForm", () => <ArrangementForm loanId="l1" onCancel={() => {}} />],
  ["ExploreCalculator (portal, en)", () => (
    <ExploreCalculator client={{ monthlyIncome: 1, monthlyExpenses: 1, existingDebt: 1 }}
      bounds={{ minAmount: 100000, maxAmount: 5000000, maxTermDays: 360, interestRatePm: 5, maxInitiationFee: 0, monthlyServiceFee: 0 } as never} />
  )],
  ["ManualPaymentForm (portal, en)", () => <ManualPaymentForm loans={[{ id: "l1", reference: "LN-1", nextInstallment: 1 }] as never} />],
  ["LeadEditForm", () => (
    <LeadEditForm lead={{ status: "NEW", source: "WEB" }} staff={[]} canEdit onChange={() => {}}
      form={{ firstName: "", lastName: "", email: "", phone: "", requestedAmount: "", notes: "", assignedToId: "" } as never}
      initial={{ firstName: "", lastName: "", email: "", phone: "", requestedAmount: "", notes: "", assignedToId: "" } as never} />
  )],
]

/** Forms whose money labels only appear after a click. */
const AFTER_CLICK: [string, () => string][] = [
  ["ConvertLeadForm (employment step)", () => textAfterPressing(
    <ConvertLeadForm lead={{ id: "l1", firstName: "A", lastName: "B", email: "a@x.invalid", phone: "1" }}
      prefill={{ "ID Number": "0000000000000" }} products={[PRODUCT]} />, "Next")],
  ["QuickPaymentCapture", () => textAfterPressing(<QuickPaymentCapture loanId="l1" loanRef="LN-1" outstanding={100000} />, "Capture Payment")],
  ["ClientNotifiedPayments (allocate)", () => {
    let renderer!: ReactTestRenderer
    const item = { id: "n1", amount: 1, reference: null, paymentDate: null, notes: null, documentId: "d1", createdAt: "2026-11-01T00:00:00Z",
      loan: { id: "l1", reference: "LN-1" }, client: { firstName: "A", lastName: "B" } }
    act(() => { renderer = create(<ClientNotifiedPayments items={[item]} canAct />) })
    const allocate = renderer.root.findAllByType("button").find((b) => /Allocate/i.test(text(b)))!
    act(() => allocate.props.onClick())
    return text(renderer.root)
  }],
  ["LogContactButton (promise to pay)", () => {
    let renderer!: ReactTestRenderer
    act(() => { renderer = create(<LogContactButton loanId="l1" clientName="A B" />) })
    act(() => renderer.root.findByType("button").props.onClick())
    const type = renderer.root.findAllByType("select").find((n) => n.props.value === "call_answered")!
    act(() => type.props.onChange({ target: { value: "promise_to_pay" } }))
    return text(renderer.root)
  }],
]

function expectSymbol(render: () => string): void {
  const za = render()
  expect(za).toMatch(/\(R\)/)
  setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
  const ls = render()
  expect(ls).toMatch(/\(M\)/)
  expect(ls).not.toMatch(/\(R\)/)
}

describe("staff form labels carry the active currency symbol", () => {
  for (const [name, element] of CASES) {
    it(`${name}: (R) for ZA, (M) for LS, never both`, () => expectSymbol(() => renderToStaticMarkup(element())))
  }
  for (const [name, render] of AFTER_CLICK) {
    it(`${name}: (R) for ZA, (M) for LS, never both`, () => expectSymbol(render))
  }
})

const WITH_FEE = {
  code: "P1", name: "Personal", productType: "PERSONAL" as const, minAmount: 1000, maxAmount: 50000, minTermDays: 30, maxTermDays: 365,
  interestRatePm: 3, interestModel: "REDUCING_BALANCE" as const, initiationFeeModel: "FLAT_PCT" as const,
  initiationFeePct: 0, initiationFeeMax: 0, monthlyServiceFee: 69, active: true,
}

describe("LoanProductForm service-fee preview", () => {
  it("prints the monthly fee with the active symbol: R69/mo for ZA, M69/mo for LS", () => {
    expect(renderToStaticMarkup(<LoanProductForm initial={WITH_FEE} />)).toMatch(/R69\/mo \u00d7/)
    setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
    const ls = renderToStaticMarkup(<LoanProductForm initial={WITH_FEE} />)
    expect(ls).toMatch(/M69\/mo \u00d7/)
    expect(ls).not.toMatch(/R69\/mo \u00d7/)
  })
})
