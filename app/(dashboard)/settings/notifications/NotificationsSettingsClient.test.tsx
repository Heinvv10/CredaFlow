import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NotificationsSettingsClient } from "./NotificationsSettingsClient"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let renderer: ReactTestRenderer

type ClientProps = Parameters<typeof NotificationsSettingsClient>[0]

/** Channel values as Prisma returns them — the `Channel` enum, uppercase. */
const STORED_EMAIL = "EMAIL" as const
const STORED_SMS = "SMS" as const

function template(overrides: Partial<ClientProps["templates"][number]> = {}): ClientProps["templates"][number] {
  return {
    id: "tpl1",
    event: "loan_approved",
    channel: STORED_EMAIL,
    key: "loan_approved_email",
    subject: "Your loan is approved",
    body: "CUSTOM COPY the operator wrote earlier",
    active: true,
    createdAt: "2026-07-25T08:00:00Z",
    updatedAt: "2026-07-25T08:00:00Z",
    ...overrides,
  }
}

function props(overrides: Partial<ClientProps> = {}): ClientProps {
  return {
    defaultEvents: [{ event: "loan_approved", label: "Loan Approved", channels: [STORED_SMS, STORED_EMAIL] }],
    templates: [template()],
    recentLogs: [],
    wabaTemplates: [],
    canEditWaba: false,
    ...overrides,
  }
}

function render(p: ClientProps = props()) {
  act(() => { renderer = create(<NotificationsSettingsClient {...p} />) })
  return renderer
}

beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => {
  act(() => renderer?.unmount())
  vi.unstubAllGlobals()
})

describe("what the tab shows", () => {
  // The lookup is keyed off the STORED channel (`EMAIL`). Lowercase literals
  // missed it, so a real template rendered as "Default" over built-in copy the
  // system never sends — the operator was reading fiction.
  it("shows the STORED body for a template that exists", () => {
    render()
    expect(JSON.stringify(renderer.toJSON())).toContain("CUSTOM COPY the operator wrote earlier")
  })

  it("marks a migration-managed row as System and names its dispatch key", () => {
    render()
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("System")
    expect(json).toContain("loan_approved_email")
  })

  // A keyless row is unreachable by dispatch, so calling it "Custom" would
  // imply it is in use — the same fiction this screen exists to remove.
  it("marks a keyless row Unused, not Custom", () => {
    render(props({ templates: [template({ key: null })] }))
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("Unused")
    expect(json).not.toContain("Custom")
  })

  // A missing row does NOT mean the event is silent: with the per-event
  // new-send flag off, lib/notifications.ts sends from buildTemplate() and
  // reads no row at all. The screen must not claim otherwise.
  it("reports a missing row without claiming the event sends nothing", () => {
    render(props({ templates: [] }))
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("No stored template row")
    expect(json).not.toMatch(/sends nothing/)
  })

  it("labels each row by its own channel", () => {
    render(props({ templates: [] }))
    const labels = renderer.root
      .findAll((n) => n.type === "span" && typeof n.props.children === "string")
      .map((n) => n.props.children as string)
      .filter((t) => t === "SMS" || t === "Email")
    expect(labels).toEqual(["SMS", "Email"])
  })
})

describe("the tab offers no write path", () => {
  // Dispatch resolves templates by `key`, which this screen cannot set, so a
  // template authored here would never send; and every row it CAN reach is a
  // system row whose copy the send path depends on — including the NCA
  // Section 129 notice. Both directions are wrong, so there is no Edit.
  it("renders no edit or save control", () => {
    render()
    // Presence anchor: proves the tab actually rendered.
    expect(JSON.stringify(renderer.toJSON())).toContain("loan_approved")
    const labels = renderer.root.findAllByType("button").flatMap((b) => {
      const children = Array.isArray(b.props.children) ? b.props.children.flat() : [b.props.children]
      return children.filter((c: unknown) => typeof c === "string") as string[]
    })
    expect(labels.some((t) => t === "Edit" || t.startsWith("Sav"))).toBe(false)
  })

  it("renders no editable field", () => {
    render()
    expect(JSON.stringify(renderer.toJSON())).toContain("loan_approved")
    expect(renderer.root.findAllByType("textarea")).toHaveLength(0)
    expect(renderer.root.findAllByType("input")).toHaveLength(0)
  })

  it("never calls the notifications API", async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal("fetch", fetchMock)
    render()
    await act(async () => {})
    expect(JSON.stringify(renderer.toJSON())).toContain("loan_approved")
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // The banner has twice shipped a false universal ("sends nothing", "only a
  // migration can set key"). The s.129 row is the standing counter-example:
  // four rows are {{body}} envelopes, that one IS the statutory letter. Pin the
  // exception so a future simplification cannot quietly restore the falsehood.
  it("does not claim every row is a passthrough envelope", () => {
    render()
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("Section 129")
    expect(json).toContain("exception")
    expect(json).toContain("statutory")
  })

  it("tells the operator why, naming the migration path", () => {
    render()
    const json = JSON.stringify(renderer.toJSON())
    expect(json).toContain("read-only")
    expect(json).toContain("buildTemplate")
    expect(json).toContain("migration")
  })
})
