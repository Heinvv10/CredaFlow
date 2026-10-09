// @vitest-environment jsdom
// The board reads its filters from the URL and writes them back with
// `router.replace`, so the "Ready only" control cannot be checked by rendering
// alone — what matters is the query string it produces and the one it clears.
// `@testing-library/react` is not installed in this repo; component
// interaction tests use `react-test-renderer`, as RateTableDetailPanel does.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApplicationsWorkspace } from "./ApplicationsWorkspace"
import type { PipelineApplication } from "@/lib/applications/pipeline-view"

const replace = vi.fn()
let searchParams = new URLSearchParams()

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace }),
  usePathname: () => "/applications",
  useSearchParams: () => searchParams,
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

function app(overrides: Partial<PipelineApplication> = {}): PipelineApplication {
  return {
    id: "app-1",
    reference: "APP-TEST-0001",
    status: "APPROVED",
    appliedAmount: 200_000,
    createdAt: new Date("2026-08-10T08:00:00.000Z"),
    submittedAt: new Date("2026-08-11T08:00:00.000Z"),
    approvedAt: new Date("2026-08-17T08:00:00.000Z"),
    disbursedAt: null,
    updatedAt: new Date("2026-08-17T08:00:00.000Z"),
    client: { firstName: "VUSI", lastName: "MOCKTEST" },
    product: { name: "30-Day Loan", productType: "SHORT_TERM" },
    branch: { name: "Belfast" },
    assignedTo: { name: "Officer One" },
    payoutRefusal: null,
    readiness: null,
    ...overrides,
  }
}

const READY = app({ id: "ready", readiness: { stage: "READY", blockers: [] } })
const BLOCKED = app({
  id: "blocked",
  readiness: { stage: "MISSING", blockers: ["Payslip missing"] },
})
const UNASSESSED = app({ id: "draft", status: "DRAFT", readiness: null })

let renderer: ReactTestRenderer | null = null

function renderBoard(applications: PipelineApplication[]) {
  act(() => {
    renderer = create(<ApplicationsWorkspace applications={applications} />)
  })
  return renderer as unknown as ReactTestRenderer
}

/** Everything the board rendered, as one string. */
function text(tree: ReactTestRenderer): string {
  const parts: string[] = []
  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      parts.push(node)
      return
    }
    if (Array.isArray(node)) {
      node.forEach(walk)
      return
    }
    if (node && typeof node === "object" && "children" in node) {
      walk((node as { children: unknown }).children)
    }
  }
  walk(tree.toJSON())
  return parts.join("")
}

function readyOnlyCheckbox(tree: ReactTestRenderer) {
  return tree.root
    .findAllByType("input")
    .find((node) => node.props.type === "checkbox")
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  replace.mockClear()
  searchParams = new URLSearchParams()
})

afterEach(() => {
  act(() => renderer?.unmount())
  renderer = null
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = false
})

describe("Ready only filter", () => {
  it("renders unchecked when the URL does not ask for it", () => {
    const tree = renderBoard([READY, BLOCKED])
    expect(readyOnlyCheckbox(tree)?.props.checked).toBe(false)
    expect(text(tree)).toContain("Ready only")
  })

  it("writes ready=1 to the URL when ticked", () => {
    const tree = renderBoard([READY, BLOCKED])
    act(() => {
      readyOnlyCheckbox(tree)?.props.onChange({ target: { checked: true } })
    })
    expect(replace).toHaveBeenCalledWith("/applications?ready=1", { scroll: false })
  })

  it("clears the parameter when unticked, rather than writing ready=0", () => {
    // A lingering `ready=0` would make a shared link read as an active filter
    // and light up the Clear affordance over an unfiltered board.
    searchParams = new URLSearchParams("ready=1")
    const tree = renderBoard([READY, BLOCKED])
    expect(readyOnlyCheckbox(tree)?.props.checked).toBe(true)
    act(() => {
      readyOnlyCheckbox(tree)?.props.onChange({ target: { checked: false } })
    })
    expect(replace).toHaveBeenCalledWith("/applications", { scroll: false })
  })

  it("hides the blocked and the un-assessed cards when on", () => {
    searchParams = new URLSearchParams("ready=1")
    const tree = renderBoard([READY, BLOCKED, UNASSESSED])
    const rendered = text(tree)
    expect(rendered).toContain("Ready to disburse")
    // An application with no chip has no gate to be ready FOR, so it is not
    // ready — it is un-assessed, and the filter drops it.
    expect(rendered).not.toContain("Payslip missing")
    expect(rendered).toContain("1 of 3 applications match")
  })

  it("counts as an active filter, so Clear is offered", () => {
    searchParams = new URLSearchParams("ready=1")
    const tree = renderBoard([READY, BLOCKED])
    expect(text(tree)).toContain("Clear")
  })

  it("is reset by Clear along with every other filter", () => {
    searchParams = new URLSearchParams("ready=1&product=30-Day%20Loan")
    const tree = renderBoard([READY, BLOCKED])
    // Found by its own rendered text, NOT by JSON.stringify-ing its props:
    // a react-test-renderer instance's children hold parent back-references,
    // and stringifying them throws on the circular structure.
    const clear = tree.root
      .findAllByType("button")
      .find((node) =>
        node.children.some((child) => typeof child === "string" && child.includes("Clear")),
      )
    act(() => clear?.props.onClick())
    expect(replace).toHaveBeenCalledWith("/applications", { scroll: false })
  })
})
