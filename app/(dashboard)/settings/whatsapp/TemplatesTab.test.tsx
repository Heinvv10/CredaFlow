import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TemplatesTab } from "./TemplatesTab"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let renderer: ReactTestRenderer

function render(wabaTemplates: Parameters<typeof TemplatesTab>[0]["wabaTemplates"] = []) {
  act(() => { renderer = create(<TemplatesTab wabaTemplates={wabaTemplates} />) })
  return renderer
}

// react-test-renderer's own findAllByType (not a hand-rolled deep predicate)
// is what avoids two problems at once: (1) React 19's dev-mode owner-stack
// tracking makes a plain JSON.stringify of pre-render children throw
// ("Converting circular structure to JSON") on the element's _owner chain,
// and (2) a hand-rolled `findAll(pred, { deep: true })` run after a prior
// state update can return the same button twice — a stale pre-update
// instance alongside the fresh one — so `[0]` can silently grab the wrong
// snapshot. collectText walks props.children directly, no serialization.
function collectText(node: unknown): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(collectText).join("")
  if (node && typeof node === "object" && "props" in (node as { props?: unknown })) {
    return collectText((node as { props?: { children?: unknown } }).props?.children)
  }
  return ""
}

function findButton(label: string) {
  return renderer.root.findAllByType("button").find((b) => collectText(b.props.children).includes(label))!
}

beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => {
  act(() => renderer?.unmount())
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

describe("TemplatesTab", () => {
  it("lists every lifecycle template with its trigger", () => {
    const json = JSON.stringify(render().toJSON())
    expect(json).toContain("Payment Overdue (7 Days)")
    expect(json).toContain("7 days after missed payment — escalation")
  })

  // The preview is the only place an operator can read what the client
  // actually receives, so a collapsed row must not be mistaken for "no copy".
  it("reveals the message preview only after the row is clicked", () => {
    render()
    expect(JSON.stringify(renderer.toJSON())).not.toContain("Your loan application")
    act(() => { findButton("Application Received").props.onClick() })
    expect(JSON.stringify(renderer.toJSON())).toContain("Your loan application")
  })

  it("previews the due-today copy with default interest and charges, not late fees", () => {
    render()
    act(() => { findButton("Payment Due Today").props.onClick() })
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("Please pay to avoid further default interest and charges.")
    expect(json).not.toContain("late fees")
  })

  it("hides the WABA approval card when Meta has reviewed nothing", () => {
    expect(JSON.stringify(render().toJSON())).not.toContain("WABA Template Approval")
  })

  it("shows Meta's review status verbatim, defaulting an unset status to PENDING", () => {
    const json = JSON.stringify(render([
      { id: "t1", wabaTemplateName: "loan_approved", providerStatus: "REJECTED" },
      { id: "t2", wabaTemplateName: "payment_due_3d", providerStatus: null },
    ]).toJSON())
    expect(json).toContain("WABA Template Approval")
    expect(json).toContain("REJECTED")
    expect(json).toContain("PENDING")
  })
})
