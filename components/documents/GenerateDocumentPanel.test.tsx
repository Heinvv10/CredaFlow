import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { GenerateDocumentPanel } from "./GenerateDocumentPanel"

vi.mock("@/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectValue: () => null,
}))

const actEnvironment = globalThis as typeof globalThis & {
  IS_REACT_ACT_ENVIRONMENT?: boolean
}

let renderer: ReactTestRenderer

function markup() {
  return JSON.stringify(renderer.toJSON())
}

describe("GenerateDocumentPanel availability", () => {
  beforeEach(() => {
    actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  })

  afterEach(async () => {
    await act(async () => renderer?.unmount())
    delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
  })

  it("explains that no published custom template is available when given no eligible options", () => {
    act(() => {
      renderer = create(<GenerateDocumentPanel clientId="client-1" templates={[]} />)
    })

    expect(markup()).toContain(
      "No published custom document templates are available for this client.",
    )
  })
})
