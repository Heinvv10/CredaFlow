// @vitest-environment jsdom
// The form follows the `initial` prop (add vs edit, or editing another insurer)
// but must not lose the user's typing when the parent re-renders with an equal
// `initial` — InsurersTable rebuilds the edit object on every render.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { BLANK_FORM, InsurerFormModal, type InsurerFormState } from "./InsurerFormModal"

const env = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

const acme: InsurerFormState = { ...BLANK_FORM, name: "Acme Life", fspNumber: "FSP 1" }
const beta: InsurerFormState = { ...BLANK_FORM, name: "Beta Assurance", fspNumber: "FSP 2" }

const modal = (initial: InsurerFormState, error: string | null = null) => (
  <InsurerFormModal open onClose={vi.fn()} title="Edit" initial={initial} onSubmit={vi.fn()} saving={false} error={error} />
)
// The accessible dialog renders in a real DOM portal.
const mounted: { root: Root; container: HTMLDivElement }[] = []
const nameInput = () => document.querySelector<HTMLInputElement>('input[placeholder="e.g. Old Mutual"]')!

async function mount(initial: InsurerFormState): Promise<Root> {
  const container = document.createElement("div")
  document.body.append(container)
  const root = createRoot(container)
  mounted.push({ root, container })
  await act(async () => { root.render(modal(initial)) })
  return root
}

beforeEach(() => { env.IS_REACT_ACT_ENVIRONMENT = true })
afterEach(async () => {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => { root.unmount() })
    container.remove()
  }
  delete env.IS_REACT_ACT_ENVIRONMENT
})

describe("InsurerFormModal", () => {
  it("starts from the initial values", async () => {
    await mount(acme)
    expect(document.querySelector('[role="dialog"]')).not.toBeNull()
    expect(nameInput().value).toBe("Acme Life")
  })

  it("resets to the new insurer when initial changes", async () => {
    const r = await mount(acme)
    await act(async () => { r.render(modal(beta)) })
    expect(nameInput().value).toBe("Beta Assurance")
  })

  it("keeps typed edits when the parent re-renders with an equal but new initial object", async () => {
    const r = await mount(acme)
    await act(async () => {
      const input = nameInput()
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, "Acme Life Ltd")
      input.dispatchEvent(new Event("input", { bubbles: true }))
    })
    await act(async () => { r.render(modal({ ...acme }, "Failed to save")) })
    expect(nameInput().value).toBe("Acme Life Ltd")
  })
})
