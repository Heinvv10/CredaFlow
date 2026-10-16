// @vitest-environment jsdom
// The form follows the `initial` prop (add vs edit, or editing another insurer)
// but must not lose the user's typing when the parent re-renders with an equal
// `initial` — InsurersTable rebuilds the edit object on every render.
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BLANK_FORM, InsurerFormModal, type InsurerFormState } from "./InsurerFormModal"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const acme: InsurerFormState = { ...BLANK_FORM, name: "Acme Life", fspNumber: "FSP 1" }
const beta: InsurerFormState = { ...BLANK_FORM, name: "Beta Assurance", fspNumber: "FSP 2" }

const modal = (initial: InsurerFormState, error: string | null = null) => (
  <InsurerFormModal open onClose={vi.fn()} title="Edit" initial={initial} onSubmit={vi.fn()} saving={false} error={error} />
)
const nameInput = (r: ReactTestRenderer) =>
  r.root.findAll((n) => n.type === "input" && n.props.placeholder === "e.g. Old Mutual")[0]

async function mount(initial: InsurerFormState): Promise<ReactTestRenderer> {
  let r!: ReactTestRenderer
  await act(async () => { r = create(modal(initial)) })
  return r
}

beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(() => { delete env.IS_REACT_ACT_ENVIRONMENT })

describe("InsurerFormModal", () => {
  it("starts from the initial values", async () => {
    expect((nameInput(await mount(acme))).props.value).toBe("Acme Life")
  })

  it("resets to the new insurer when initial changes", async () => {
    const r = await mount(acme)
    await act(async () => { r.update(modal(beta)) })
    expect(nameInput(r).props.value).toBe("Beta Assurance")
  })

  it("keeps typed edits when the parent re-renders with an equal but new initial object", async () => {
    const r = await mount(acme)
    await act(async () => { nameInput(r).props.onChange({ target: { value: "Acme Life Ltd" } }) })
    await act(async () => { r.update(modal({ ...acme }, "Failed to save")) })
    expect(nameInput(r).props.value).toBe("Acme Life Ltd")
  })
})
