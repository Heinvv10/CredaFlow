import { describe, it, expect } from "vitest"
import { resolveClientTab } from "./client-tabs"

describe("resolveClientTab", () => {
  it("passes through a known tab", () => {
    expect(resolveClientTab("documents")).toBe("documents")
    expect(resolveClientTab("bureau")).toBe("bureau")
  })

  it("falls back to applications when undefined", () => {
    expect(resolveClientTab(undefined)).toBe("applications")
  })

  it("falls back to applications for an unknown value", () => {
    expect(resolveClientTab("not-a-real-tab")).toBe("applications")
  })

  it("falls back to applications for an empty string", () => {
    expect(resolveClientTab("")).toBe("applications")
  })
})
