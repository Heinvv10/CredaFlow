import { renderToString } from "react-dom/server"
import { act, create } from "react-test-renderer"
import { describe, expect, it } from "vitest"
import { useHydrated } from "./use-hydrated"

function Probe() {
  return <span>{useHydrated() ? "client" : "server"}</span>
}

describe("useHydrated", () => {
  it("is false when rendered on the server", () => {
    expect(renderToString(<Probe />)).toContain("server")
  })

  it("is true on a client render", () => {
    const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    g.IS_REACT_ACT_ENVIRONMENT = true
    let r!: ReturnType<typeof create>
    act(() => { r = create(<Probe />) })
    expect(JSON.stringify(r.toJSON())).toContain("client")
  })
})
