import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const refresh = vi.hoisted(() => vi.fn())
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh }) }))
vi.mock("@/lib/toast", () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

import { PaymentPlanButton } from "./PaymentPlanButton"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true; refresh.mockReset() })
afterEach(() => { vi.unstubAllGlobals(); delete env.IS_REACT_ACT_ENVIRONMENT })

const text = (children: unknown): string =>
  children == null || typeof children === "boolean" ? ""
    : typeof children === "string" || typeof children === "number" ? String(children)
      : Array.isArray(children) ? children.map(text).join("")
        : text((children as { props?: { children?: unknown } }).props?.children)

describe("PaymentPlanButton", () => {
  // Audit row 114: R2,058.34 over 3 showed only 3 x R686.11 (R2,058.33).
  it("shows the larger final instalment when the arrears do not divide evenly", async () => {
    let r!: ReactTestRenderer
    await act(async () => { r = create(<PaymentPlanButton loanId="L1" clientName="Kabelo M" arrearsAmount={205_834} arrearsAmountDisplay="R 2,058.34" />) })
    await act(async () => r.root.findAll((n) => n.type === "button")[0].props.onClick())
    const out = r.root.findAll((n) => typeof n.type === "string").map((n) => text(n.props.children)).join(" | ")
    expect(out).toContain("R 686.11")
    expect(out).toContain("Final instalment: R 686.12")
  })

  // Fair Score audit 2026-10-16: the stage panel and history did not refresh.
  it("refreshes the server-rendered collections page after a plan is created", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }))
    let r!: ReactTestRenderer
    await act(async () => { r = create(<PaymentPlanButton loanId="L1" clientName="Kabelo M" arrearsAmount={676_125} arrearsAmountDisplay="R 6,761.25" />) })
    await act(async () => r.root.findAll((n) => n.type === "button")[0].props.onClick())
    const save = r.root.findAll((n) => n.type === "button" && /Create|Save|Confirm/.test(text(n.props.children)))[0]
    await act(async () => { await save.props.onClick() })
    expect(refresh).toHaveBeenCalled()
  })
})
