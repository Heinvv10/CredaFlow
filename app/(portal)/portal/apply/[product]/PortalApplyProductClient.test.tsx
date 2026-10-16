import { act, create, type ReactTestRenderer } from "react-test-renderer"
import type { ReactNode } from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))
vi.mock("next/link", () => ({
  default: ({
    children,
    href,
    ...props
  }: {
    children: ReactNode
    href: string
  }) => <a href={href} {...props}>{children}</a>,
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

import { PortalApplyProductClient } from "./PortalApplyProductClient"
import type { ReactTestInstance } from "react-test-renderer"

// The PASQ-delivery checkbox is the one whose label text names the
// Pre-Agreement Statement — position-independent, so it stays correct
// whether or not the credit-life block renders above it.
function findPasqCheckbox(root: ReactTestInstance): ReactTestInstance {
  const label = root.findAllByType("label").find((candidate) =>
    candidate.findAllByType("span").some((span) =>
      span.children.some(
        (child) => typeof child === "string" && child.includes("Pre-Agreement Statement"),
      ),
    ),
  )
  if (!label) throw new Error("PASQ delivery checkbox label not found")
  return label.findByProps({ type: "checkbox" })
}

function findSubmitButton(root: ReactTestInstance): ReactTestInstance {
  return root.findAllByType("button").find((b) => b.props.type === "submit")!
}

describe("PortalApplyProductClient credit-life acknowledgement", () => {
  let renderer!: ReactTestRenderer

  beforeEach(async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(
        <PortalApplyProductClient
        lenderName="Acme Lending"
        ncrNumber="NCRCP99999"
          productKey="personal"
          product={{
            id: "product-1",
            name: "Personal Loan",
            code: "PERSONAL",
            productType: "PERSONAL",
            minAmount: 200_000,
            maxAmount: 10_000_000,
            minTermDays: 30,
            maxTermDays: 90,
          }}
          client={{
            firstName: "Synthetic",
            lastName: "Customer",
            idNumber: "9912310000085",
            phone: "0820000301",
            email: "synthetic@example.test",
            monthlyIncome: 2_000_000,
            monthlyExpenses: 500_000,
            existingDebt: 0,
          }}
          qualification={null}
          creditLifeOffer={{
            productId: "credit-life-1",
            productName: "Synthetic Credit Life",
            insurerId: "insurer-1",
            insurerName: "Synthetic Insurer",
            autoBundleEnabled: true,
          }}
        />,
      )
    })
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("starts the variable term empty and blocks submit until a valid term is chosen", async () => {
    const termInput = () => renderer.root.findByProps({ id: "termDays" })
    expect(termInput().props.value).toBe("")

    await act(async () => renderer.root.findByProps({ id: "amount" }).props.onChange({ target: { value: "5000" } }))
    await act(async () => renderer.root.findByProps({ id: "purpose" }).props.onChange({ target: { value: "stock purchase" } }))
    await act(async () => renderer.root.findAllByType("input").filter(
      (i) => i.props.type === "radio" && i.props.name === "creditLifeElection",
    )[1].props.onChange())
    const checkboxByText = (text: string) => renderer.root.findAllByType("label").find((l) =>
      l.findAllByType("span").some((sp) => sp.children.filter((c) => typeof c === "string").join("").includes(text)),
    )!.findByProps({ type: "checkbox" })
    await act(async () => checkboxByText("income, expenses and debt").props.onChange({ target: { checked: true } }))
    await act(async () => findPasqCheckbox(renderer.root).props.onChange({ target: { checked: true } }))

    const ack = () => checkboxByText("before PASQ generation")
    // Everything else is complete; only the term is missing.
    await act(async () => ack().props.onChange({ target: { checked: true } }))
    expect(termInput().props.value).toBe("")
    expect(findSubmitButton(renderer.root).props.disabled).toBe(true)

    await act(async () => termInput().props.onChange({ target: { value: "45" } }))
    await act(async () => ack().props.onChange({ target: { checked: true } }))
    expect(findSubmitButton(renderer.root).props.disabled).toBe(false)

    await act(async () => termInput().props.onChange({ target: { value: "" } }))
    await act(async () => ack().props.onChange({ target: { checked: true } }))
    expect(findSubmitButton(renderer.root).props.disabled).toBe(true)
  })

  it("starts the amount empty and blocks submit until it is within the product range", async () => {
    const amountInput = () => renderer.root.findByProps({ id: "amount" })
    expect(amountInput().props.value).toBe("")
    const radios = () => renderer.root.findAllByType("input").filter(
      (i) => i.props.type === "radio" && i.props.name === "creditLifeElection",
    )
    const labelByText = (text: string) => renderer.root.findAllByType("label").find((l) =>
      l.findAllByType("span").some((sp) => sp.children.filter((c) => typeof c === "string").join("").includes(text)),
    )
    const checkboxByText = (text: string) => labelByText(text)!.findByProps({ type: "checkbox" })

    await act(async () => renderer.root.findByProps({ id: "purpose" }).props.onChange({ target: { value: "stock purchase" } }))
    await act(async () => renderer.root.findByProps({ id: "termDays" }).props.onChange({ target: { value: "45" } }))
    await act(async () => checkboxByText("income, expenses and debt").props.onChange({ target: { checked: true } }))

    // No amount: the credit-life block must not render at all (no election
    // radios, no "not available" disclosure).
    expect(radios()).toHaveLength(0)
    expect(JSON.stringify(renderer.toJSON())).not.toContain("not available")
    expect(findSubmitButton(renderer.root).props.disabled).toBe(true)

    const setAmount = async (value: string) => {
      await act(async () => amountInput().props.onChange({ target: { value } }))
      if (radios().length === 0) return
      await act(async () => radios()[1].props.onChange())
      await act(async () => checkboxByText("before PASQ generation").props.onChange({ target: { checked: true } }))
      await act(async () => findPasqCheckbox(renderer.root).props.onChange({ target: { checked: true } }))
    }

    // Valid eligible amount: the offer renders.
    await setAmount("5000")
    expect(radios()).toHaveLength(2)
    expect(JSON.stringify(renderer.toJSON())).toContain("exact monthly")
    expect(findSubmitButton(renderer.root).props.disabled).toBe(false)

    // Below range, above range, and absurd (used to throw a RangeError in render).
    for (const bad of ["", "1999", "100001", "3000000000000000", "1e300"]) {
      await setAmount(bad)
      expect(radios()).toHaveLength(0)
      expect(JSON.stringify(renderer.toJSON())).not.toContain("not available")
      expect(findSubmitButton(renderer.root).props.disabled).toBe(true)
    }
  })

  it("clears the disclosure acknowledgement when a variable term changes", async () => {
    await act(async () => renderer.root.findByProps({ id: "amount" }).props.onChange({ target: { value: "5000" } }))
    const acceptedElection = renderer.root.findAllByType("input").find(
      (input) => input.props.type === "radio" && input.props.name === "creditLifeElection",
    )!
    await act(async () => acceptedElection.props.onChange())

    const disclosureCheckbox = () => renderer.root.findAllByType("input").find(
      (input) =>
        input.props.type === "checkbox"
        && typeof input.props.onChange === "function"
        && input.props.disabled !== undefined,
    )!
    await act(async () => {
      disclosureCheckbox().props.onChange({ target: { checked: true } })
    })
    expect(disclosureCheckbox().props.checked).toBe(true)

    const termInput = renderer.root.findByProps({ id: "termDays" })
    await act(async () => {
      termInput.props.onChange({ target: { value: "60" } })
    })

    expect(disclosureCheckbox().props.checked).toBe(false)
  })

  it("keeps the PASQ checkbox gated behind the disclosure acknowledgement while cover is offered", async () => {
    // With an offer on screen and no acknowledgement yet, the PASQ-delivery
    // checkbox must stay disabled — the fix for the no-offer case must not
    // remove the gate when cover IS offered.
    await act(async () => renderer.root.findByProps({ id: "amount" }).props.onChange({ target: { value: "5000" } }))
    expect(findPasqCheckbox(renderer.root).props.disabled).toBe(true)

    const declineElection = renderer.root.findAllByType("input").filter(
      (input) => input.props.type === "radio" && input.props.name === "creditLifeElection",
    )[1]
    await act(async () => declineElection.props.onChange())
    const disclosureCheckbox = renderer.root.findAllByType("input").find(
      (input) =>
        input.props.type === "checkbox"
        && input.props.checked === false
        && input.props.disabled === false
        && input !== findPasqCheckbox(renderer.root),
    )!
    await act(async () => disclosureCheckbox.props.onChange({ target: { checked: true } }))

    expect(findPasqCheckbox(renderer.root).props.disabled).toBe(false)
  })
})

describe("PortalApplyProductClient with no credit-life offer", () => {
  let renderer!: ReactTestRenderer

  beforeEach(async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(
        <PortalApplyProductClient
        lenderName="Acme Lending"
        ncrNumber="NCRCP99999"
          productKey="micro"
          product={{
            id: "product-1",
            name: "Micro Loan",
            code: "MICRO30",
            productType: "MICRO",
            minAmount: 200_000,
            maxAmount: 1_000_000,
            minTermDays: 30,
            maxTermDays: 30,
          }}
          client={{
            firstName: "Synthetic",
            lastName: "Customer",
            idNumber: "9912310000085",
            phone: "0820000301",
            email: "synthetic@example.test",
            monthlyIncome: 2_000_000,
            monthlyExpenses: 500_000,
            existingDebt: 0,
          }}
          qualification={null}
          creditLifeOffer={null}
        />,
      )
    })
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  // Regression: when the only CREDIT_LIFE product has no insurer, every
  // portal applicant gets creditLifeOffer === null. The old
  // `disabled={!creditLifeDisclosureAcknowledged}` gate could then never
  // open (the disclosure block doesn't render), which made the portal
  // application permanently unsubmittable — for every customer.
  it("does not gate the PASQ checkbox on an acknowledgement that cannot exist", () => {
    expect(findPasqCheckbox(renderer.root).props.disabled).toBe(false)
  })

  it("lets the applicant reach a submittable form", async () => {
    expect(findSubmitButton(renderer.root).props.disabled).toBe(true)

    await act(async () => renderer.root.findByProps({ id: "amount" }).props.onChange({ target: { value: "5000" } }))
    const purpose = renderer.root.findByProps({ id: "purpose" })
    await act(async () => purpose.props.onChange({ target: { value: "stock purchase" } }))

    const affordability = renderer.root.findAllByType("input").find(
      (input) => input.props.type === "checkbox" && input !== findPasqCheckbox(renderer.root),
    )!
    await act(async () => affordability.props.onChange({ target: { checked: true } }))

    // test-renderer invokes handlers even on disabled inputs, so assert the
    // checkbox is actually reachable before toggling it — a real browser
    // would refuse the click.
    expect(findPasqCheckbox(renderer.root).props.disabled).toBe(false)
    await act(async () => {
      findPasqCheckbox(renderer.root).props.onChange({ target: { checked: true } })
    })

    expect(findSubmitButton(renderer.root).props.disabled).toBe(false)
  })

  describe("submit", () => {
    const fetchMock = vi.fn()

    beforeEach(() => {
      fetchMock.mockReset()
      fetchMock.mockResolvedValue({ ok: true, json: async () => ({ id: "app-1" }) })
      vi.stubGlobal("fetch", fetchMock)
    })
    afterEach(() => vi.unstubAllGlobals())

    async function fillAllButAmount() {
      await act(async () => renderer.root.findByProps({ id: "purpose" }).props.onChange({ target: { value: "stock purchase" } }))
      const affordability = renderer.root.findAllByType("input").find(
        (input) => input.props.type === "checkbox" && input !== findPasqCheckbox(renderer.root),
      )!
      await act(async () => affordability.props.onChange({ target: { checked: true } }))
      await act(async () => findPasqCheckbox(renderer.root).props.onChange({ target: { checked: true } }))
    }
    const submit = () => act(async () => {
      await renderer.root.findByType("form").props.onSubmit({ preventDefault: () => {} })
    })

    it("posts the amount as amountCents / 100 for a typed value", async () => {
      await fillAllButAmount()
      await act(async () => renderer.root.findByProps({ id: "amount" }).props.onChange({ target: { value: "5000.50" } }))
      await submit()
      expect(fetchMock).toHaveBeenCalledTimes(1)
      expect(JSON.parse(fetchMock.mock.calls[0][1].body).amount).toBe(5000.5)
    })

    it("keeps submit disabled for a blank or out-of-range amount and enables it for a valid one", async () => {
      await fillAllButAmount()
      const setAmount = (value: string) =>
        act(async () => renderer.root.findByProps({ id: "amount" }).props.onChange({ target: { value } }))
      for (const bad of ["", "1999"]) {
        await setAmount(bad)
        expect(findSubmitButton(renderer.root).props.disabled).toBe(true)
      }
      await setAmount("5000")
      expect(findSubmitButton(renderer.root).props.disabled).toBe(false)
    })

    it("sends nothing when the amount is empty", async () => {
      await fillAllButAmount()
      await submit()
      expect(fetchMock).not.toHaveBeenCalled()
    })
  })
})
