import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
}))

import { ApplicationSubmitButton } from "./ApplicationSubmitButton"

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

describe("ApplicationSubmitButton", () => {
  let renderer!: ReactTestRenderer

  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    await act(async () => renderer.unmount())
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("renders disabled with the inline reason when submission is known-impossible", async () => {
    // Regression: the button was always enabled and the operator only
    // learned about the missing credit-life election from a post-click
    // error toast.
    await act(async () => {
      renderer = create(
        <ApplicationSubmitButton
          applicationId="app-1"
          blockedReason="Open Edit draft and record the client's credit-life election and exact-premium disclosure first."
        />,
      )
    })

    const button = renderer.root.findAllByType("button")[0]
    expect(button.props.disabled).toBe(true)
    expect(button.props.onClick).toBeUndefined()
    const hint = renderer.root.findAllByType("p")[0]
    expect(hint.children.join("")).toContain("credit-life election")
  })

  it("stays actionable when no blocking reason exists", async () => {
    await act(async () => {
      renderer = create(<ApplicationSubmitButton applicationId="app-1" />)
    })

    const button = renderer.root.findAllByType("button")[0]
    expect(button.props.disabled).toBe(false)
    expect(button.props.onClick).toBeTypeOf("function")
  })
})
