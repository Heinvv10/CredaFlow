import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sessionWizardStore } from "./session-storage"

interface MockData { a: string; b: number }

describe("sessionWizardStore", () => {
  beforeEach(() => {
    const store: Record<string, string> = {}
    vi.stubGlobal("sessionStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => { store[k] = v },
      removeItem: (k: string) => { delete store[k] },
    })
  })

  afterEach(() => { vi.unstubAllGlobals() })

  it("save then load round-trips JSON", () => {
    const s = sessionWizardStore<MockData>("test.v1")
    s.save({ a: "hello", b: 42 })
    expect(s.load()).toEqual({ a: "hello", b: 42 })
  })

  it("load returns null when key is absent", () => {
    expect(sessionWizardStore<MockData>("nope.v1").load()).toBeNull()
  })

  it("clear removes the key", () => {
    const s = sessionWizardStore<MockData>("test.v1")
    s.save({ a: "x", b: 1 })
    s.clear()
    expect(s.load()).toBeNull()
  })

  it("load returns null when JSON is malformed", () => {
    ;(globalThis.sessionStorage as Storage).setItem("bad.v1", "{not json")
    expect(sessionWizardStore<MockData>("bad.v1").load()).toBeNull()
  })

  it("load returns null when window is undefined (SSR)", () => {
    vi.unstubAllGlobals()
    expect(sessionWizardStore<MockData>("ssr.v1").load()).toBeNull()
  })
})
