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

  it("clears the disclosure acknowledgement when a variable term changes", async () => {
    const acceptedElection = renderer.root.findAllByType("input").find(
      (input) =>
        input.props.type === "radio"
        && input.props.name === "creditLifeElection"
        && input.props.disabled === false,
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
})
