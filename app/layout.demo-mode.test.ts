import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { connectionMock } = vi.hoisted(() => ({ connectionMock: vi.fn() }))

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  connection: connectionMock,
}))
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "font-sans" }),
  Geist_Mono: () => ({ variable: "font-mono" }),
}))

import { generateMetadata } from "./layout"

beforeEach(() => {
  connectionMock.mockReset()
  connectionMock.mockResolvedValue(undefined)
})

afterEach(() => vi.unstubAllEnvs())

describe("root layout metadata", () => {
  it("is noindex, nofollow when DEMO_MODE=true", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    expect((await generateMetadata()).robots).toEqual({ index: false, follow: false })
  })

  it.each([undefined, "false", "TRUE "])("adds no robots rule when DEMO_MODE=%j", async (value) => {
    vi.stubEnv("DEMO_MODE", value)
    const metadata = await generateMetadata()
    expect(metadata.robots).toBeUndefined()
    expect(metadata.title).toBe("Client and staff workspace")
  })

  it("waits for the request before reading DEMO_MODE, so a prerender cannot bake it", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    connectionMock.mockImplementation(() => new Promise<void>(() => {}))
    const result = generateMetadata().then(() => "resolved")
    expect(await Promise.race([result, new Promise((r) => setTimeout(() => r("waiting"), 20))])).toBe("waiting")
  })
})
