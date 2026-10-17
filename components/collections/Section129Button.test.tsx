import type { ReactNode } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))
vi.mock("next/link", () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }))
vi.mock("@/lib/toast", () => ({ toast: { section129: { sent: vi.fn(), simulated: vi.fn(), failed: vi.fn() } } }))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div data-dialog>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}))

import { Section129Button } from "./Section129Button"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { vi.unstubAllGlobals(); delete env.IS_REACT_ACT_ENVIRONMENT })

// Visible text only: a reason tucked into a title attribute is not on screen.
function text(r: ReactTestRenderer): string {
  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (node == null) return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node === "string") return void parts.push(node)
    if (typeof node === "object" && "children" in (node as object)) walk((node as { children?: unknown }).children)
  }
  walk(r.toJSON())
  return parts.join(" ")
}
function nodeText(children: unknown): string {
  if (children == null || typeof children === "boolean") return ""
  if (typeof children === "string" || typeof children === "number") return String(children)
  if (Array.isArray(children)) return children.map(nodeText).join("")
  const el = children as { props?: { children?: unknown } }
  return el.props ? nodeText(el.props.children) : ""
}
const buttonWith = (r: ReactTestRenderer, label: string) =>
  r.root.findAll((n) => n.type === "button" && nodeText(n.props.children).includes(label))[0]

async function confirmAndSend(response: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ status: 422, json: async () => response }))
  let r!: ReactTestRenderer
  await act(async () => { r = create(<Section129Button loanId="L1" loanRef="LN-1" clientName="Kabelo Mokoena" />) })
  expect(text(r)).not.toContain("Send a Section 129 notice?")
  await act(async () => buttonWith(r, "S.129").props.onClick())
  return r
}

describe("Section129Button", () => {
  // Fair Score audit 2026-10-16: the confirmation was a tiny inline "Send/Cancel".
  it("confirms in a dialog that names the loan, the borrower and that the notice cannot be withdrawn", async () => {
    const r = await confirmAndSend({ ok: true })
    expect(text(r)).toContain("Send a Section 129 notice?")
    expect(text(r)).toContain("LN-1")
    expect(text(r)).toContain("Kabelo Mokoena")
    expect(text(r)).toContain("cannot be withdrawn")
    await act(async () => buttonWith(r, "Cancel").props.onClick())
    expect(text(r)).not.toContain("Send a Section 129 notice?")
  })

  // ...and a failure showed only "Failed", the reason hidden in a tooltip.
  it("keeps the reason of a failed notice on screen", async () => {
    const r = await confirmAndSend({ ok: false, error: "Email not configured for this tenant. Go to Settings → Email." })
    await act(async () => { await buttonWith(r, "Send notice").props.onClick() })
    expect(text(r)).toContain("Notice not sent")
    expect(text(r)).toContain("Email not configured for this tenant. Go to Settings → Email.")
  })

  it("says a demo notice was simulated, not sent", async () => {
    const r = await confirmAndSend({ ok: true, simulated: true, message: "Section 129 notice simulated (not sent): a@b.invalid is a demo mailbox that cannot receive mail." })
    await act(async () => { await buttonWith(r, "Send notice").props.onClick() })
    expect(text(r)).toContain("Simulated (not sent)")
  })
})
