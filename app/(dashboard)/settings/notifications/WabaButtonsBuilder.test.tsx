import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { WabaButtonsBuilder } from "./WabaButtonsBuilder"
import { buildButtonsComponent, type StoredTemplateButton } from "@/lib/whatsapp/template-buttons"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let renderer: ReactTestRenderer

beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { act(() => renderer?.unmount()) })

function render(buttons: StoredTemplateButton[], onChange = vi.fn()) {
  act(() => { renderer = create(<WabaButtonsBuilder buttons={buttons} onChange={onChange} />) })
  return onChange
}

function control(label: string) {
  return renderer.root.findAll(
    (n) => (n.type === "input" || n.type === "select") && n.props["aria-label"] === label,
  )[0]
}

describe("type switching", () => {
  // The property the component exists to guarantee: a row carries ONLY the keys
  // its type declares. A stale phoneNumber on a URL row would be stored, and
  // the stored blob is the contract the send path reads.
  it("replaces the whole row on type change, leaving no stale keys", () => {
    const onChange = render([{ type: "PHONE_NUMBER", text: "Call", phoneNumber: "27110000000" }])
    act(() => { control("Button 1 type").props.onChange({ target: { value: "URL" } }) })
    const next = onChange.mock.calls[0][0][0]
    expect(next).toEqual({ type: "URL", text: "", url: "https://" })
    expect(next).not.toHaveProperty("phoneNumber")
  })

  it("drops the url when switching away from a URL button", () => {
    const onChange = render([{ type: "URL", text: "Pay", url: "https://x.co.za" }])
    act(() => { control("Button 1 type").props.onChange({ target: { value: "QUICK_REPLY" } }) })
    expect(onChange.mock.calls[0][0][0]).toEqual({ type: "QUICK_REPLY", text: "" })
  })

  // Guards the module-level BLANK constant against being handed out by
  // reference, which would alias two rows to one object.
  it("gives each row its own object when two rows switch to the same type", () => {
    const first = vi.fn()
    render([{ type: "QUICK_REPLY", text: "a" }, { type: "QUICK_REPLY", text: "b" }], first)
    act(() => { control("Button 1 type").props.onChange({ target: { value: "URL" } }) })
    act(() => { control("Button 2 type").props.onChange({ target: { value: "URL" } }) })
    const rowA = first.mock.calls[0][0][0]
    const rowB = first.mock.calls[1][0][1]
    expect(rowA).toEqual(rowB)
    expect(rowA).not.toBe(rowB)
  })
})

describe("editing", () => {
  it("edits a label without disturbing the row's other fields", () => {
    const onChange = render([{ type: "URL", text: "Pay", url: "https://x.co.za/{{ref}}" }])
    act(() => { control("Button 1 label").props.onChange({ target: { value: "Pay now" } }) })
    expect(onChange.mock.calls[0][0][0]).toEqual({
      type: "URL", text: "Pay now", url: "https://x.co.za/{{ref}}",
    })
  })

  it("removes the addressed row only", () => {
    const onChange = render([
      { type: "QUICK_REPLY", text: "a" },
      { type: "QUICK_REPLY", text: "b" },
      { type: "QUICK_REPLY", text: "c" },
    ])
    const remove = renderer.root.findAllByType("button")
      .find((b) => b.props["aria-label"] === "Remove button 2")!
    act(() => { remove.props.onClick() })
    expect(onChange.mock.calls[0][0]).toEqual([
      { type: "QUICK_REPLY", text: "a" },
      { type: "QUICK_REPLY", text: "c" },
    ])
  })
})

// The builder writes the stored contract; buildButtonsComponent is what the
// server and Meta read it back through. Pairing them here catches a shape the
// editor can produce but the platform would reject.
describe("what it produces is registrable", () => {
  it("emits rows the real translator accepts once filled in", () => {
    const onChange = render([])
    const add = renderer.root.findAllByType("button").find((b) => {
      const children = Array.isArray(b.props.children) ? b.props.children.flat() : [b.props.children]
      return children.some((c: unknown) => typeof c === "string" && c.includes("Add button"))
    })!
    act(() => { add.props.onClick() })
    const added = onChange.mock.calls[0][0] as StoredTemplateButton[]
    expect(added).toEqual([{ type: "QUICK_REPLY", text: "" }])

    const filled: StoredTemplateButton[] = [{ ...added[0], text: "Yes" }]
    expect(buildButtonsComponent(filled)).toEqual({
      type: "BUTTONS",
      buttons: [{ type: "QUICK_REPLY", text: "Yes" }],
    })
  })

  it("produces a blank URL row the translator rejects until a real url is typed", () => {
    const onChange = render([{ type: "QUICK_REPLY", text: "x" }])
    act(() => { control("Button 1 type").props.onChange({ target: { value: "URL" } }) })
    const row = onChange.mock.calls[0][0]
    // "https://" with an empty label — the operator must finish it, and the
    // preview says so rather than the editor pretending it is valid.
    expect(() => buildButtonsComponent(row)).toThrow(/text is required/)
  })
})
