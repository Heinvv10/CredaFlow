import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { DocumentTemplatesTable } from "./DocumentTemplatesTable"

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

let renderer: ReactTestRenderer

function markup() {
  return JSON.stringify(renderer.toJSON())
}

describe("DocumentTemplatesTable availability", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    await act(async () => renderer?.unmount())
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("labels system, published, unpublished, and inactive template rows accurately", () => {
    act(() => {
      renderer = create(
        <DocumentTemplatesTable
          templates={[
            { id: "system", key: "agreement", name: "Credit Agreement", kind: "SYSTEM", isActive: true, currentVersionIsActive: false },
            { id: "published", key: "welcome", name: "Welcome Letter", kind: "CUSTOM", isActive: true, currentVersionIsActive: true },
            { id: "unpublished", key: "application", name: "Electronic Application Form", kind: "CUSTOM", isActive: true, currentVersionIsActive: false },
            { id: "inactive", key: "legacy", name: "Legacy Letter", kind: "CUSTOM", isActive: false, currentVersionIsActive: true },
          ] as never}
        />,
      )
    })

    expect(markup()).toContain("Workflow managed")
    expect(markup()).toContain("Published")
    expect(markup()).toContain("Not published")
    expect(markup()).toContain("Inactive")
  })
})
