import type { ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const refresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div data-dialog>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}))

import { DisburseForm, PAYMENT_REFERENCE_PLACEHOLDER } from "./DisburseForm"

const props = {
  applicationId: "app-1",
  repaymentMethod: "DEBIT_ORDER" as const,
  principalCents: 3_000_000,
  disbursementCents: 3_000_000,
  clientName: "Synthetic Client",
  clientBankDetails: { bankName: "Nedbank", bankAccountNumber: "1234567890", bankBranchCode: "198765", accountType: "CHEQUE" },
}

describe("DisburseForm", () => {
  it("renders as one full-width rail button until opened", () => {
    const html = renderToStaticMarkup(<DisburseForm {...props} />)
    expect(html).toContain("Disburse Loan")
    expect(html).toMatch(/<button[^>]*class="[^"]*w-full/)
    expect(html).not.toContain("Payment Reference")
  })

  // Fair Score audit 2026-10-16: the placeholder showed a stale April date.
  it("suggests no dated example reference", () => {
    expect(PAYMENT_REFERENCE_PLACEHOLDER).not.toMatch(/\d{8}/)
    expect(PAYMENT_REFERENCE_PLACEHOLDER).not.toContain("DISB-2026")
  })
})

describe("DisburseForm interaction", () => {
  const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  const nodeText = (children: unknown): string =>
    children == null || typeof children === "boolean" ? ""
      : typeof children === "string" || typeof children === "number" ? String(children)
        : Array.isArray(children) ? children.map(nodeText).join("")
          : nodeText((children as { props?: { children?: unknown } }).props?.children)

  async function openAndConfirm() {
    let r!: ReactTestRenderer
    await act(async () => { r = create(<DisburseForm {...props} />) })
    const button = (label: string) => r.root.findAll((n) => n.type === "button" && nodeText(n.props.children).includes(label))[0]
    await act(async () => button("Disburse Loan").props.onClick())
    const confirm = r.root.findAll((n) => n.type === "input" && n.props.type === "checkbox")[0]
    await act(async () => confirm.props.onChange({ target: { checked: true } }))
    return { r, button }
  }

  beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true; refresh.mockReset() })
  afterEach(() => { vi.unstubAllGlobals(); delete env.IS_REACT_ACT_ENVIRONMENT })

  it("posts once, closes the dialog and keeps the button disabled after a payout", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ success: true }) })
    vi.stubGlobal("fetch", fetchMock)
    const { r, button } = await openAndConfirm()
    await act(async () => { await button("Confirm - Disburse").props.onClick() })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock).toHaveBeenCalledWith("/api/applications/app-1/disburse", expect.objectContaining({ method: "POST" }))
    expect(refresh).toHaveBeenCalled()
    expect(r.root.findAll((n) => n.props["data-dialog"] === true)).toHaveLength(0)
    expect(button("Disbursed").props.disabled).toBe(true)
  })

  it("sends one POST for a double click", async () => {
    let resolve!: (value: unknown) => void
    const fetchMock = vi.fn().mockReturnValue(new Promise((r) => { resolve = r }))
    vi.stubGlobal("fetch", fetchMock)
    const { button } = await openAndConfirm()
    const confirmButton = button("Confirm - Disburse")
    await act(async () => { void confirmButton.props.onClick(); void confirmButton.props.onClick() })
    await act(async () => { resolve({ ok: true, status: 200, json: async () => ({}) }) })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("shows a refusal as an alert, also when the body is not JSON", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new SyntaxError("Unexpected token <") } }))
    const { r, button } = await openAndConfirm()
    await act(async () => { await button("Confirm - Disburse").props.onClick() })
    const alert = r.root.findAll((n) => n.type === "p" && n.props.role === "alert")[0]
    expect(nodeText(alert.props.children)).toBe("Disbursement failed (HTTP 502).")
  })

  it("labels every field it shows", async () => {
    const { r } = await openAndConfirm()
    const ids = r.root.findAll((n) => n.type === "input" && n.props.type !== "checkbox").map((n) => n.props.id)
    const targets = r.root.findAll((n) => n.type === "label" && n.props.htmlFor).map((n) => n.props.htmlFor)
    expect(ids).toHaveLength(5)
    for (const id of ids) expect(targets).toContain(id)
  })
})
