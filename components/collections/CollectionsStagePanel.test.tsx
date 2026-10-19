import { act, create } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { CollectionsStagePanel } from "./CollectionsStagePanel"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { delete env.IS_REACT_ACT_ENVIRONMENT })

const text = (children: unknown): string =>
  children == null || typeof children === "boolean" ? ""
    : typeof children === "string" || typeof children === "number" ? String(children)
      : Array.isArray(children) ? children.map(text).join("")
        : text((children as { props?: { children?: unknown } }).props?.children)

async function render(props: { daysInArrears: number; section129Unavailable?: string }) {
  let r!: ReturnType<typeof create>
  await act(async () => {
    r = create(
      <CollectionsStagePanel
        loanId="L1"
        currentStage="FORMAL_REMINDER"
        arrearsAmount={100_000}
        existingArrangement={null}
        existingReferral={null}
        {...props}
      />,
    )
  })
  return r.root.findAll((n) => typeof n.type === "string").map((n) => text(n.props.children)).join(" | ")
}

// Audit row 115: the hint pointed at an S.129 action that was disabled below 90 DPD.
describe("CollectionsStagePanel S.129 hint", () => {
  it("points at the S.129 action when it is available", async () => {
    const out = await render({ daysInArrears: 95 })
    expect(out).toContain("Use the “S.129 Notice” action above")
  })

  it("does not point at the action when it is unavailable, and says why", async () => {
    const out = await render({
      daysInArrears: 45,
      section129Unavailable: "the account is below the 90-day arrears threshold",
    })
    expect(out).not.toContain("Use the “S.129 Notice” action above")
    expect(out).toContain("Section 129 cannot be issued yet: the account is below the 90-day arrears threshold")
  })
})
