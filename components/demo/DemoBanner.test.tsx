import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const { connectionMock, getResolvedTenantIdMock, getLenderBrandNameMock } = vi.hoisted(() => ({
  connectionMock: vi.fn(),
  getResolvedTenantIdMock: vi.fn(),
  getLenderBrandNameMock: vi.fn(),
}))

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  connection: connectionMock,
}))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId: getResolvedTenantIdMock }))
vi.mock("@/lib/config/identity", async (orig) => ({
  ...(await orig<typeof import("@/lib/config/identity")>()),
  getLenderBrandName: getLenderBrandNameMock,
}))

import { LenderIdentityError } from "@/lib/config/identity"
import { DEMO_BANNER_FALLBACK } from "@/lib/config/demo-mode"
import { DemoBanner } from "./DemoBanner"

async function render(): Promise<string> {
  return renderToStaticMarkup(await DemoBanner())
}

beforeEach(() => {
  vi.resetAllMocks()
  connectionMock.mockResolvedValue(undefined)
  getResolvedTenantIdMock.mockResolvedValue("tenant-1")
  getLenderBrandNameMock.mockResolvedValue("Acme Lending")
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe("DemoBanner", () => {
  it.each([undefined, "false", "TRUE "])("renders nothing when DEMO_MODE=%j", async (value) => {
    vi.stubEnv("DEMO_MODE", value)
    expect(await render()).toBe("")
    expect(getLenderBrandNameMock).not.toHaveBeenCalled()
  })

  it("reads nothing until the request arrives, so a prerender cannot bake DEMO_MODE", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    // During a prerender connection() never resolves: rendering stops there.
    connectionMock.mockImplementation(() => new Promise<void>(() => {}))
    const result = DemoBanner().then(() => "rendered")
    expect(await Promise.race([result, new Promise((r) => setTimeout(() => r("waiting"), 20))])).toBe("waiting")
    expect(getResolvedTenantIdMock).not.toHaveBeenCalled()
  })

  it("names the tenant's brand and publishes its height when DEMO_MODE=true", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    const html = await render()
    expect(html).toContain("Demo environment — Acme Lending is a fictional lender.")
    expect(html).toContain("--cf-demo-banner-h:3rem")
    expect(html).toContain("data-demo-banner")
  })

  it("uses the generic wording, silently, when the lender is not configured", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    getLenderBrandNameMock.mockRejectedValue(new LenderIdentityError(["tenant"], "not configured"))
    expect(await render()).toContain(DEMO_BANNER_FALLBACK)
    expect(error).not.toHaveBeenCalled()
  })

  it("uses the generic wording but reports any other failure", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const fault = new Error("connection refused")
    getResolvedTenantIdMock.mockRejectedValue(fault)
    expect(await render()).toContain(DEMO_BANNER_FALLBACK)
    expect(error).toHaveBeenCalledWith(expect.any(String), fault)
  })
})
