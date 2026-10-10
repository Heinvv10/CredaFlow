import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import { MentionPicker } from "./MentionPicker"

// react-test-renderer, not @testing-library/react: the latter is not a
// dependency of this repo (same pattern as ClientCommsTab.test.tsx and
// app/(dashboard)/inbox/Composer.test.tsx). A test importing it would die on
// module resolution before a single assertion ran.
const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const staff = [
  { id: "u2", name: "Bo Nkosi", email: "bo@x.co" },
  { id: "u3", name: "Cy Dlamini", email: "cy@x.co" },
]

let renderer: ReactTestRenderer | undefined

function render(props: Parameters<typeof MentionPicker>[0]) {
  act(() => { renderer = create(<MentionPicker {...props} />) })
  return renderer!
}

function labels(r: ReactTestRenderer): string[] {
  return r.root.findAllByType("button").map((b) => b.props.children as string)
}

function pick(r: ReactTestRenderer, label: string) {
  act(() => {
    r.root.findAllByType("button").find((b) => b.props.children === label)!.props.onClick()
  })
}

beforeEach(() => { actEnvironment.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => {
  if (renderer) act(() => renderer!.unmount())
  renderer = undefined
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

it("filters by the typed query", () => {
  const r = render({ staff, query: "cy", onPick: vi.fn() })

  expect(labels(r)).toEqual(["Cy Dlamini"])
})

it("returns the picked staff member", () => {
  const onPick = vi.fn()
  const r = render({ staff, query: "", onPick })

  pick(r, "Bo Nkosi")

  expect(onPick).toHaveBeenCalledTimes(1)
  // The whole object, not just the label: the composer needs `id` to build the
  // mentionUserIds list, and a picker that handed back only a name would ping
  // nobody.
  expect(onPick).toHaveBeenCalledWith(staff[0])
})

it("renders nothing when no one matches", () => {
  const r = render({ staff, query: "zzz", onPick: vi.fn() })

  expect(r.toJSON()).toBeNull()
})

// /api/staff/mentionable returns `name` as string | null (a staffer who never
// set one). Falling through to the email keeps them mentionable instead of
// rendering an empty, unclickable row.
it("falls back to the email address for a staffer with no name", () => {
  const nameless = { id: "u4", name: null, email: "dee@x.co" }
  const onPick = vi.fn()
  const r = render({ staff: [nameless], query: "dee", onPick })

  expect(labels(r)).toEqual(["dee@x.co"])
  pick(r, "dee@x.co")
  expect(onPick).toHaveBeenCalledWith(nameless)
})

it("matches case-insensitively on the middle of a name", () => {
  const r = render({ staff, query: "NKO", onPick: vi.fn() })

  expect(labels(r)).toEqual(["Bo Nkosi"])
})

// The keyboard-active row. The composer owns the index; this asserts the picker
// paints the row it was told about, so arrowing has a visible affordance.
function selectedLabel(r: ReactTestRenderer): string | undefined {
  return r.root
    .findAllByType("button")
    .filter((b) => b.props["aria-selected"] === true)
    .map((b) => b.props.children as string)[0]
}

it("marks the first row active by default", () => {
  const r = render({ staff, query: "", onPick: vi.fn() })

  expect(selectedLabel(r)).toBe("Bo Nkosi")
  expect(r.root.findAllByType("button").filter((b) => b.props["aria-selected"] === true)).toHaveLength(1)
})

it("marks the requested row active and gives it the raised surface", () => {
  const r = render({ staff, query: "", activeIndex: 1, onPick: vi.fn() })

  expect(selectedLabel(r)).toBe("Cy Dlamini")
  const active = r.root.findAllByType("button").find((b) => b.props["aria-selected"] === true)!
  // Split into class tokens, not a substring match: every row carries
  // `hover:bg-[var(--cf-bg-raised)]`, so `toContain` would pass with no
  // keyboard affordance painted at all.
  expect((active.props.className as string).split(/\s+/)).toContain("bg-[var(--cf-bg-raised)]")
  const inactive = r.root.findAllByType("button").find((b) => b.props["aria-selected"] === false)!
  expect((inactive.props.className as string).split(/\s+/)).not.toContain("bg-[var(--cf-bg-raised)]")
})

// The filtered list shrinks one render before the composer's index resets, so an
// index past the end must still paint a row rather than none.
it("clamps an activeIndex past the end of the filtered list", () => {
  const r = render({ staff, query: "cy", activeIndex: 5, onPick: vi.fn() })

  expect(selectedLabel(r)).toBe("Cy Dlamini")
})

// lib/inbox/notes.ts discards the author's own mention, so offering
// the row inserts "@Me" and pings nobody with no feedback at all.
it("leaves out the row for the excluded author", () => {
  const r = render({ staff, query: "", excludeUserId: "u2", onPick: vi.fn() })

  expect(labels(r)).toEqual(["Cy Dlamini"])
})

it("renders nothing when the only match is the excluded author", () => {
  const r = render({ staff, query: "bo", excludeUserId: "u2", onPick: vi.fn() })

  expect(r.toJSON()).toBeNull()
})
