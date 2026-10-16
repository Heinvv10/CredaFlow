import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock("next/link", () => ({ default: ({ children, href }: { children: ReactNode; href: string }) => <a href={href}>{children}</a> }))

import { PortalApplyProductClient } from "./PortalApplyProductClient"

// Fair Score audit 2026-10-16 (portal apply): the credit-life box appeared only
// after typing and moved the checkboxes under the cursor; changing the amount
// cleared the confirmation silently; the term was asked in days.

const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const client = {
  firstName: "Synthetic", lastName: "Customer", idNumber: "9912310000085", phone: "0820000301",
  email: "synthetic@example.test", monthlyIncome: 2_000_000, monthlyExpenses: 500_000, existingDebt: 0,
}
const offer = { productId: "cl-1", productName: "Synthetic Credit Life", insurerId: "ins-1", insurerName: "Synthetic Insurer", autoBundleEnabled: true }
const personal = {
  id: "p1", name: "Personal Loan", code: "PERSONAL", productType: "PERSONAL" as const,
  minAmount: 200_000, maxAmount: 10_000_000, minTermDays: 90, maxTermDays: 1800, interestModel: "REDUCING_BALANCE",
}

let renderer!: ReactTestRenderer
const text = () => JSON.stringify(renderer.toJSON())
const byId = (id: string) => renderer.root.findByProps({ id })
const labelByText = (s: string) => renderer.root.findAllByType("label").find((l) =>
  l.findAllByType("span").some((sp) => sp.children.filter((c) => typeof c === "string").join("").includes(s)))
const radios = () => renderer.root.findAllByType("input").filter((i) => i.props.type === "radio" && i.props.name === "creditLifeElection")
const creditLifeBoxes = () => renderer.root.findAll((n: ReactTestInstance) => n.props["data-credit-life-box"] === true)

async function mount(product = personal) {
  await act(async () => {
    renderer = create(
      <PortalApplyProductClient productKey="personal" lenderName="Acme Lending" ncrNumber="NCRCP00000"
        product={product} client={client} qualification={null} creditLifeOffer={offer} />,
    )
  })
}

beforeEach(() => { g.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(async () => {
  await act(async () => renderer.unmount())
  delete g.IS_REACT_ACT_ENVIRONMENT
  vi.unstubAllGlobals()
})

describe("portal apply form layout", () => {
  it("reserves the credit-life box before an amount is typed, so nothing below it moves", async () => {
    await mount()
    expect(creditLifeBoxes()).toHaveLength(1)
    expect(text()).toContain("Enter an amount to see your credit-life cover options")
    await act(async () => byId("amount").props.onChange({ target: { value: "30000" } }))
    expect(creditLifeBoxes()).toHaveLength(1)
  })

  async function fillAllButTerm() {
    await act(async () => byId("amount").props.onChange({ target: { value: "30000" } }))
    await act(async () => byId("purpose").props.onChange({ target: { value: "home repairs" } }))
    await act(async () => radios()[1].props.onChange())
    await act(async () => labelByText("before PASQ generation")!.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }))
    await act(async () => labelByText("income, expenses and debt")!.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }))
    await act(async () => labelByText("Pre-Agreement Statement")!.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }))
  }
  const submitButton = () => renderer.root.findAllByType("button").find((b) => b.props.type === "submit")!

  it("asks a monthly product's term in months and posts it as days", async () => {
    await mount()
    expect(text()).toContain("Term (months) — between 3 and 60")
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ id: "a1" }) }))
    vi.stubGlobal("fetch", fetchMock)
    await act(async () => byId("termDays").props.onChange({ target: { value: "18" } }))
    await fillAllButTerm()
    expect(submitButton().props.disabled).toBe(false)
    await act(async () => { await renderer.root.findByType("form").props.onSubmit({ preventDefault: () => {} }) })
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body).termDays).toBe(540)
  })

  it("refuses a months term outside the product range", async () => {
    await mount()
    await act(async () => byId("termDays").props.onChange({ target: { value: "1000" } }))
    await fillAllButTerm()
    expect(submitButton().props.disabled).toBe(true)
  })

  it("keeps the confirmation when the amount changes but the premium shown does not", async () => {
    await mount()
    await act(async () => byId("amount").props.onChange({ target: { value: "30000" } }))
    await act(async () => radios()[1].props.onChange())
    const ack = () => labelByText("before PASQ generation")!.findByProps({ type: "checkbox" })
    await act(async () => ack().props.onChange({ target: { checked: true } }))
    // R4.50 per R1,000 in whole cents: one cent more borrowed, the same premium.
    await act(async () => byId("amount").props.onChange({ target: { value: "30000.01" } }))
    expect(ack().props.checked).toBe(true)
    expect(text()).not.toContain("please confirm")
  })

  // Review of #152: declining is a decision about the premium shown too, so a
  // declined borrower must reconfirm when the premium changes.
  it("clears a DECLINED confirmation when the premium shown changes", async () => {
    await mount()
    await act(async () => byId("amount").props.onChange({ target: { value: "30000" } }))
    await act(async () => radios()[1].props.onChange())
    const ack = () => labelByText("before PASQ generation")!.findByProps({ type: "checkbox" })
    await act(async () => ack().props.onChange({ target: { checked: true } }))
    await act(async () => byId("amount").props.onChange({ target: { value: "35000" } }))
    expect(ack().props.checked).toBe(false)
    expect(text()).toContain("please confirm your choice again")
  })

  it("clears the confirmation when the premium it confirmed changes, and says so", async () => {
    await mount()
    await act(async () => byId("amount").props.onChange({ target: { value: "30000" } }))
    await act(async () => radios()[0].props.onChange())
    const ack = () => labelByText("before PASQ generation")!.findByProps({ type: "checkbox" })
    await act(async () => ack().props.onChange({ target: { checked: true } }))
    await act(async () => byId("amount").props.onChange({ target: { value: "35000" } }))
    expect(ack().props.checked).toBe(false)
    expect(text()).toContain("The amount changed your credit-life premium — please confirm your choice again.")
  })

  it("keeps a day-based product's term in days", async () => {
    await mount({ ...personal, minTermDays: 7, maxTermDays: 30, interestModel: "SIMPLE" })
    expect(text()).toContain("Term (days) — between 7 and 30")
  })
})
