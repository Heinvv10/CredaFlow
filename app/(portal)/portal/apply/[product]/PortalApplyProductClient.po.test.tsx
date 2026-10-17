import { act, create, type ReactTestRenderer, type ReactTestInstance } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { push } = vi.hoisted(() => ({ push: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ push, refresh: vi.fn() }) }))
vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }))

import { PortalApplyProductClient } from "./PortalApplyProductClient"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

describe("PortalApplyProductClient for PO funding", () => {
  let renderer!: ReactTestRenderer

  beforeEach(async () => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(
        <PortalApplyProductClient
          lenderName="Acme Lending" ncrNumber="NCRCP00000" productKey="po"
          product={{
            id: "p-po", name: "Purchase Order Funding", code: "POFUND", productType: "PO_FUNDING",
            minAmount: 1_000_000, maxAmount: 50_000_000, minTermDays: 30, maxTermDays: 120,
          }}
          client={{
            firstName: "Synthetic", lastName: "Owner", idNumber: "9912310000085", phone: "0820000301",
            email: "owner@example.test", monthlyIncome: 3_000_000, monthlyExpenses: 1_000_000, existingDebt: 0,
          }}
          qualification={null}
          creditLifeOffer={null}
        />,
      )
    })
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    vi.unstubAllGlobals()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  const byId = (id: string) => renderer.root.findByProps({ id })
  const change = (id: string, value: string) => act(async () => byId(id).props.onChange({ target: { value } }))
  const submitButton = () => renderer.root.findAllByType("button").find((b) => b.props.type === "submit")!
  const checkbox = (text: string) => renderer.root.findAllByType("label").find((l: ReactTestInstance) =>
    l.findAllByType("span").some((sp) => sp.children.filter((c) => typeof c === "string").join("").includes(text)),
  )!.findByProps({ type: "checkbox" })

  async function fillConsumerParts() {
    await change("amount", "50000")
    await change("termDays", "60")
    await change("purpose", "Supply 400 school uniforms")
    await act(async () => checkbox("income, expenses and debt").props.onChange({ target: { checked: true } }))
    await act(async () => checkbox("Pre-Agreement Statement").props.onChange({ target: { checked: true } }))
  }

  it("states the supported borrower assessment before order details are captured", () => {
    const text = JSON.stringify(renderer.toJSON())
    expect(text).toContain("income, expenses and existing debts")
    expect(text).toContain("full scheduled repayment")
    expect(text).not.toContain("not sized on your salary")
  })

  it("offers only the Business purpose — no medical or funeral", () => {
    const options = byId("category").findAllByType("option").map((o) => o.props.value)
    expect(options).toEqual(["BUSINESS"])
  })

  it("will not submit until the PO number, buyer and order document are given", async () => {
    await fillConsumerParts()
    expect(submitButton().props.disabled).toBe(true)
    await change("poNumber", "PO-2026-0412")
    await change("poBuyerName", "Synthetic Schools Trust")
    expect(submitButton().props.disabled).toBe(true)
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "po.pdf", { type: "application/pdf" })
    await act(async () => byId("poDocument").props.onChange({ target: { files: [file] } }))
    expect(submitButton().props.disabled).toBe(false)
  })

  it("uploads the order as a PO document, then applies naming it", async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url === "/api/documents" ? Response.json({ id: "doc-po" }, { status: 201 }) : Response.json({ id: "app-1" }, { status: 201 }))
    vi.stubGlobal("fetch", fetchMock)
    await fillConsumerParts()
    await change("poNumber", "PO-2026-0412")
    await change("poBuyerName", "Synthetic Schools Trust")
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "po.pdf", { type: "application/pdf" })
    await act(async () => byId("poDocument").props.onChange({ target: { files: [file] } }))

    await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault: () => undefined }))

    expect(fetchMock.mock.calls[0][0]).toBe("/api/documents")
    const upload = (fetchMock.mock.calls[0] as unknown as [string, { body: FormData }])[1].body
    expect(upload.get("docType")).toBe("PO_DOCUMENT")
    const apply = JSON.parse((fetchMock.mock.calls[1] as unknown as [string, { body: string }])[1].body)
    expect(apply).toMatchObject({
      productCode: "POFUND", loanPurposeCategory: "BUSINESS",
      poNumber: "PO-2026-0412", poBuyerName: "Synthetic Schools Trust", poDocumentId: "doc-po",
    })
    expect(push).toHaveBeenCalledWith("/portal/applications/app-1")
  })
})
