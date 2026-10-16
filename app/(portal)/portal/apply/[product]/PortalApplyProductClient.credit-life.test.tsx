import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }))
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }))

import { PortalApplyProductClient } from "./PortalApplyProductClient"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

// The audit: a credit-life product was configured but cover was unavailable
// (auto-bundling off), and the form said "not available" while still showing a
// disabled "Add the offered credit-life cover" radio.
describe("PortalApplyProductClient when credit-life cover is not available", () => {
  let renderer!: ReactTestRenderer

  beforeEach(async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(
        <PortalApplyProductClient
          lenderName="Acme Lending" ncrNumber="NCRCP00000" productKey="personal"
          product={{
            id: "p1", name: "Personal Loan", code: "PERSONAL", productType: "PERSONAL",
            minAmount: 200_000, maxAmount: 10_000_000, minTermDays: 90, maxTermDays: 1800,
          }}
          client={{
            firstName: "Synthetic", lastName: "Customer", idNumber: "9912310000085", phone: "0820000301",
            email: "synthetic@example.test", monthlyIncome: 2_000_000, monthlyExpenses: 500_000, existingDebt: 0,
          }}
          qualification={null}
          creditLifeOffer={{
            productId: "cl-1", productName: "Synthetic Credit Life", insurerId: "ins-1",
            insurerName: "Synthetic Insurer", autoBundleEnabled: false,
          }}
        />,
      )
    })
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  const change = (id: string, value: string) =>
    act(async () => renderer.root.findByProps({ id }).props.onChange({ target: { value } }))
  const radios = () => renderer.root.findAllByType("input").filter((i) => i.props.type === "radio")
  const labelled = (text: string) => renderer.root.findAllByType("label").find((l: ReactTestInstance) =>
    l.findAllByType("span").some((sp) => sp.children.filter((c) => typeof c === "string").join("").includes(text)),
  )
  const tick = (text: string) => act(async () => labelled(text)!.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }))
  const submitButton = () => renderer.root.findAllByType("button").find((b) => b.props.type === "submit")!

  it("shows no election radio, only that cover is not available", async () => {
    await change("amount", "30000")
    expect(radios()).toHaveLength(0)
    const text = JSON.stringify(renderer.toJSON())
    expect(text).toContain("Credit-life cover is not available for this application")
    expect(text).not.toContain("Add the offered credit-life cover")
  })

  it("submits as proceeding without cover once the applicant acknowledges it", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "app-1" }, { status: 201 }))
    vi.stubGlobal("fetch", fetchMock)
    await change("amount", "30000")
    await change("termDays", "540")
    await change("purpose", "Home repairs")
    await tick("income, expenses and debt")
    expect(submitButton().props.disabled).toBe(true)
    await tick("proceed without credit-life cover")
    await tick("Pre-Agreement Statement")
    expect(submitButton().props.disabled).toBe(false)

    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault: () => undefined }))

    const sent = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)
    expect(sent).toMatchObject({ creditLifeElection: "DECLINED", creditLifeDisclosureAcknowledged: true })
  })
})
