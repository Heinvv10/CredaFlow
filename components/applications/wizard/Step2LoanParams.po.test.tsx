// @vitest-environment jsdom
// A real DOM: the PO fields load the client's purchase orders and upload one.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { Step2LoanParams } from "./Step2LoanParams"
import { EMPTY_APPLICATION_WIZARD_DATA, type ApplicationProduct, type ApplicationWizardData } from "./types"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
const base: ApplicationProduct = {
  productType: "PERSONAL", id: "p1", name: "Personal Loan", code: "PERSONAL", minAmount: 2000, maxAmount: 100000,
  minTermDays: 90, maxTermDays: 1800, interestRate: 0.03, interestRatePm: 0.03, interestModel: "REDUCING_BALANCE",
  initiationFeeModel: "NCA_REG42", initiationFeePct: 0.165, initiationFeeMax: 108000, monthlyServiceFee: 6900,
}
const poProduct: ApplicationProduct = { ...base, id: "po", name: "Purchase Order Funding", code: "POFUND", productType: "PO_FUNDING" }

let container: HTMLDivElement
let root: Root
const patch = vi.fn()

async function mount(data: Partial<ApplicationWizardData>) {
  await act(async () => root.render(
    <Step2LoanParams data={{ ...EMPTY_APPLICATION_WIZARD_DATA, clientId: "c1", ...data }} patch={patch} errors={{}} mode="staff" products={[base, poProduct]} />,
  ))
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  patch.mockReset()
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("Step2LoanParams PO funding", () => {
  it("shows no PO fields for a consumer product", async () => {
    await mount({ productId: "p1" })
    expect(container.querySelector("#poNumber")).toBeNull()
    const options = [...container.querySelectorAll("#loanPurposeCategory option")].map((o) => (o as HTMLOptionElement).value)
    expect(options).toContain("MEDICAL")
  })

  it("sets the Business purpose when PO funding is chosen", async () => {
    await mount({ productId: "p1" })
    const poRadio = container.querySelector<HTMLInputElement>('input[value="po"]')!
    await act(async () => poRadio.click())
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ productId: "po", loanPurposeCategory: "BUSINESS" }))
  })

  it("for PO funding: Business only, the order facts, and the client's purchase orders to pick from", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json([
      { id: "doc-po", docType: "PO_DOCUMENT", fileName: "po-0412.pdf", createdAt: "2026-10-15T08:00:00.000Z" },
      { id: "doc-id", docType: "ID_COPY", fileName: "id.pdf", createdAt: "2026-10-15T08:00:00.000Z" },
    ])))
    await mount({ productId: "po", loanPurposeCategory: "BUSINESS" })
    const options = [...container.querySelectorAll("#loanPurposeCategory option")].map((o) => (o as HTMLOptionElement).value)
    expect(options).toEqual(["BUSINESS"])
    expect(container.querySelector("#poNumber")).not.toBeNull()
    expect(container.querySelector("#poBuyerName")).not.toBeNull()
    const docs = [...container.querySelectorAll("#poDocumentId option")].map((o) => (o as HTMLOptionElement).value)
    expect(docs).toEqual(["", "doc-po"])
  })

  it("uploads a purchase order as the client's PO_DOCUMENT and selects it", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) =>
      url === "/api/documents" && init?.method === "POST"
        ? Response.json({ id: "doc-new" }, { status: 201 })
        : Response.json([]))
    vi.stubGlobal("fetch", fetchMock)
    await mount({ productId: "po", loanPurposeCategory: "BUSINESS" })
    const input = container.querySelector<HTMLInputElement>("#poDocumentUpload")!
    const file = new File([new Uint8Array([0x25, 0x50, 0x44, 0x46])], "po.pdf", { type: "application/pdf" })
    Object.defineProperty(input, "files", { value: [file] })
    await act(async () => { input.dispatchEvent(new Event("change", { bubbles: true })) })

    const upload = fetchMock.mock.calls.find((c) => c[0] === "/api/documents")!
    const form = (upload[1] as RequestInit).body as FormData
    expect(form.get("docType")).toBe("PO_DOCUMENT")
    expect(form.get("clientId")).toBe("c1")
    expect(patch).toHaveBeenCalledWith({ poDocumentId: "doc-new" })
  })
})
