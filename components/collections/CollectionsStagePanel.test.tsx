import { act, create } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }))

import { CollectionsStagePanel } from "./CollectionsStagePanel"
import type { Section129Block } from "@/lib/collections/section129-hint"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { delete env.IS_REACT_ACT_ENVIRONMENT })

const text = (children: unknown): string =>
  children == null || typeof children === "boolean" ? ""
    : typeof children === "string" || typeof children === "number" ? String(children)
      : Array.isArray(children) ? children.map(text).join("")
        : text((children as { props?: { children?: unknown } }).props?.children)

async function render(props: { daysInArrears: number; section129Unavailable?: Section129Block }) {
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
      section129Unavailable: { reason: "the account is below the 90-day arrears threshold", temporary: true },
    })
    expect(out).not.toContain("Use the “S.129 Notice” action above")
    expect(out).toContain("Section 129 cannot be issued yet: the account is below the 90-day arrears threshold")
  })
})

// Hein, D2: a hold disables ONLY the reminder moves, with the reason beside them.
describe("CollectionsStagePanel under a client hold", () => {
  const reason = "the client is under debt review (NCA s.86 notice received 15 Oct 2026, recorded on loan LN-2)"

  async function panel(stage: "NONE" | "SOFT_REMINDER" | "SECTION_129_SENT" | "PAYMENT_ARRANGEMENT", reminderHoldReason?: string) {
    let r!: ReturnType<typeof create>
    await act(async () => {
      r = create(
        <CollectionsStagePanel
          loanId="L1" currentStage={stage} daysInArrears={45} arrearsAmount={100_000}
          existingArrangement={null} existingReferral={null} reminderHoldReason={reminderHoldReason}
        />,
      )
    })
    const buttons = r.root.findAllByType("button").map((b) => ({ label: text(b.props.children), disabled: Boolean(b.props.disabled) }))
    const all = r.root.findAll((n) => typeof n.type === "string").map((n) => text(n.props.children)).join(" | ")
    return { buttons, all }
  }

  it.each([["NONE", "Send Soft Reminder (WA)"], ["SOFT_REMINDER", "Issue Formal Reminder"]] as const)(
    "at %s: the reminder move is disabled and the reason is shown beside it",
    async (stage, label) => {
      const { buttons, all } = await panel(stage, reason)
      expect(buttons.find((b) => b.label.includes(label))).toMatchObject({ disabled: true })
      expect(all).toContain(`Reminder moves are paused: ${reason}.`)
    },
  )

  it("the same reminder move is enabled, with no notice, when there is no hold", async () => {
    const { buttons, all } = await panel("NONE")
    expect(buttons.find((b) => b.label.includes("Send Soft Reminder"))).toMatchObject({ disabled: false })
    expect(all).not.toContain("Reminder moves are paused")
  })

  it.each(["SOFT_REMINDER", "SECTION_129_SENT"] as const)(
    "at %s: Record Payment Arrangement stays usable under the hold",
    async (stage) => {
      const { buttons } = await panel(stage, reason)
      expect(buttons.find((b) => b.label.includes("Record Payment Arrangement"))).toMatchObject({ disabled: false })
    },
  )

  it("at SECTION_129_SENT: Refer to Attorney stays usable under the hold", async () => {
    const { buttons } = await panel("SECTION_129_SENT", reason)
    expect(buttons.find((b) => b.label.includes("Refer to Attorney"))).toMatchObject({ disabled: false })
  })

  it("at PAYMENT_ARRANGEMENT: the attorney move stays usable, and no reminder notice is shown", async () => {
    const { buttons, all } = await panel("PAYMENT_ARRANGEMENT", reason)
    expect(buttons.find((b) => b.label.includes("Refer to Attorney"))).toMatchObject({ disabled: false })
    expect(all).not.toContain("Reminder moves are paused")
  })
})
