// @vitest-environment jsdom
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { refreshMock, toastSuccess } = vi.hoisted(() => ({ refreshMock: vi.fn(), toastSuccess: vi.fn() }))
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: refreshMock }) }))
vi.mock("next/link", () => ({ default: ({ children, href }: { children: unknown; href: string }) => <a href={href}>{children as never}</a> }))
vi.mock("@/lib/toast", () => ({ toast: { success: toastSuccess, error: vi.fn() } }))

import { ClientNotifiedPayments, type ClientNotifiedPayment } from "./ClientNotifiedPayments"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let container: HTMLDivElement
let root: Root

const item: ClientNotifiedPayment = {
  id: "pn1", amount: 84_330, reference: "EFT SEP", paymentDate: "2026-10-14T22:00:00.000Z", notes: null,
  documentId: "d1", createdAt: "2026-10-15T08:00:00.000Z",
  loan: { id: "l1", reference: "LN-0005" }, client: { firstName: "Elize", lastName: "Synthetic" },
}

beforeEach(async () => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(<ClientNotifiedPayments items={[item]} canAct />))
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  vi.clearAllMocks()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

const button = (text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text)!
const click = (text: string) => act(async () => button(text).click())

describe("ClientNotifiedPayments", () => {
  it("shows the report with its proof of payment", () => {
    expect(container.textContent).toContain("Elize Synthetic")
    expect(container.textContent).toContain("LN-0005")
    expect(container.querySelector('a[href="/api/documents/d1/view"]')).not.toBeNull()
  })

  it("allocates the reported amount on the reported day, then refreshes", async () => {
    const fetchMock = vi.fn(async () => Response.json({ id: "pn1", status: "ALLOCATED", paymentId: "pay1" }))
    vi.stubGlobal("fetch", fetchMock)
    await click("Allocate")
    await click("Confirm allocation")
    expect(fetchMock).toHaveBeenCalledWith("/api/payment-notifications/pn1", expect.objectContaining({
      method: "PATCH",
      body: JSON.stringify({ action: "allocate", amount: 84_330, receivedAt: "2026-10-15" }),
    }))
    expect(toastSuccess).toHaveBeenCalled()
    expect(refreshMock).toHaveBeenCalled()
  })

  it("shows the server's refusal and stays open", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: "Give the reason for rejecting it (5–500 characters)" }, { status: 400 })))
    await click("Reject")
    await click("Confirm rejection")
    expect(container.textContent).toContain("Give the reason for rejecting it")
    expect(refreshMock).not.toHaveBeenCalled()
  })

  it("offers no Allocate or Reject to a role that cannot act on it", async () => {
    await act(async () => root.render(<ClientNotifiedPayments items={[item]} canAct={false} />))
    const labels = [...container.querySelectorAll("button")].map((b) => b.textContent)
    expect(labels).not.toContain("Allocate")
    expect(labels).not.toContain("Reject")
    expect(container.textContent).toContain("Elize Synthetic")
  })
})
