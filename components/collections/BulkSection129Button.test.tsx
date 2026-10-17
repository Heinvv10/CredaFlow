import type { ReactNode } from "react"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/link", () => ({ default: ({ children }: { children: ReactNode }) => <a>{children}</a> }))
vi.mock("@/components/ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) => (open ? <div>{children}</div> : null),
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogFooter: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
}))

import { BulkSection129Button } from "./BulkSection129Button"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { vi.unstubAllGlobals(); delete env.IS_REACT_ACT_ENVIRONMENT })

function visible(r: ReactTestRenderer): string {
  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (node == null) return
    if (Array.isArray(node)) return node.forEach(walk)
    if (typeof node === "string") return void parts.push(node)
    if (typeof node === "object" && "children" in (node as object)) walk((node as { children?: unknown }).children)
  }
  walk(r.toJSON())
  return parts.join("")
}
const nodeText = (c: unknown): string => c == null || typeof c === "boolean" ? "" : typeof c === "string" ? c
  : Array.isArray(c) ? c.map(nodeText).join("") : nodeText((c as { props?: { children?: unknown } }).props?.children)

async function sendAll(response: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ json: async () => response }))
  let r!: ReactTestRenderer
  await act(async () => { r = create(<BulkSection129Button count90Plus={3} />) })
  const button = (label: string) => r.root.findAll((n) => n.type === "button" && nodeText(n.props.children).includes(label))[0]
  await act(async () => button("Bulk S.129").props.onClick())
  expect(visible(r)).toContain("cannot be withdrawn")
  await act(async () => { await button("Send all").props.onClick() })
  return r
}

describe("BulkSection129Button", () => {
  it("lists why each notice was not sent, and counts the simulated ones", async () => {
    const r = await sendAll({
      ok: false, sent: 2, failed: 1, skipped: 0,
      results: [
        { reference: "LN-1", outcome: "SENT", simulated: true },
        { reference: "LN-2", outcome: "SENT" },
        { reference: "LN-3", outcome: "FAILED", error: "Email not configured for this tenant. Go to Settings → Email." },
      ],
    })
    expect(visible(r)).toContain("2 sent (1 simulated, not sent)")
    expect(visible(r)).toContain("LN-3: not sent — Email not configured for this tenant. Go to Settings → Email.")
  })
})
