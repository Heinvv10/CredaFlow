import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"

vi.mock("next/link", () => ({ default: ({ children }: { children: unknown }) => children }))

import { Step1ClientSelect } from "./Step1ClientSelect"
import { ClientPicker } from "@/components/wizard/ClientPicker"
import { EMPTY_APPLICATION_WIZARD_DATA } from "./types"

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

// A PO document belongs to one client: carrying it to another client would
// name someone else's purchase order (prepareApplicationFields then refuses).
describe("Step1ClientSelect", () => {
  let renderer!: ReactTestRenderer
  const patch = vi.fn()

  afterEach(async () => {
    await act(async () => renderer.unmount())
    patch.mockReset()
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  async function pick(id: string) {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
    await act(async () => {
      renderer = create(
        <Step1ClientSelect
          data={{ ...EMPTY_APPLICATION_WIZARD_DATA, clientId: "c1", poDocumentId: "doc-po-c1" }}
          patch={patch} errors={{}} mode="staff" clients={[]}
        />,
      )
    })
    await act(async () => renderer.root.findByType(ClientPicker).props.onSelect(id))
  }

  it("clears the chosen purchase order when the client changes", async () => {
    await pick("c2")
    expect(patch).toHaveBeenCalledWith(expect.objectContaining({ clientId: "c2", poDocumentId: "" }))
  })

  it("keeps it when the same client is picked again", async () => {
    await pick("c1")
    expect(patch.mock.calls[0][0]).not.toHaveProperty("poDocumentId")
  })
})
