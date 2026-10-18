import { describe, expect, it, vi } from "vitest"
import type { ApiResponse, SimClient } from "./api"
import { verifyPageResponse } from "./verify-page-response"
const body = (status = 200, location?: string, type = "text/html", text = "<html>Deal detail</html>"): ApiResponse => ({ status, headers: new Headers({ "content-type": type, ...(location ? { location } : {}) }), json: null, text, bytes: new TextEncoder().encode(text) })
function actor(...responses: ApiResponse[]) { return { baseUrl: "http://localhost:3300", get: vi.fn(async () => responses.shift()!) } as unknown as Pick<SimClient, "baseUrl" | "get"> }
describe("server page verifier expected asset application redirect", () => {
  it.each(["/asset-finance/deals/deal-1", "http://localhost:3300/asset-finance/deals/deal-1"])("follows only the mapped canonical307 %s", async location => {
    const a = actor(body(307, location), body())
    expect(await verifyPageResponse(a, "/applications/app-1", "/asset-finance/deals/deal-1")).toMatchObject({ ok: true, destination: "/asset-finance/deals/deal-1" })
    expect(a.get).toHaveBeenCalledTimes(2)
    expect(a.get).toHaveBeenLastCalledWith("/asset-finance/deals/deal-1", expect.anything())
  })
  it.each([[302, "/asset-finance/deals/deal-1"], [303, "/asset-finance/deals/deal-1"], [308, "/asset-finance/deals/deal-1"], [307, "/login"], [307, "/asset-finance/deals/other"], [307, "https://external.invalid/asset-finance/deals/deal-1"], [307, "//external.invalid/asset-finance/deals/deal-1"], [307, "/asset-finance/deals/deal-1?x=1"], [307, "/asset-finance/deals/deal-1#fragment"]] as const)("refuses unexpected %s %s without follow", async (status, location) => {
    const a = actor(body(status, location));expect((await verifyPageResponse(a, "/applications/app-1", "/asset-finance/deals/deal-1")).ok).toBe(false);expect(a.get).toHaveBeenCalledTimes(1)
  })
  it.each(["/asset-finance/deals/deal-1", "/login", "https://external.invalid/deal-1"])("refuses mapped200 or invalid expected path %s", async expected => {
    const a = actor(body());expect((await verifyPageResponse(a, "/applications/app-1", expected)).ok).toBe(false);expect(a.get).toHaveBeenCalledTimes(1)
  })
  it("does not allow a portal or unmapped consumer redirect", async () => {
    const a = actor(body(307, "/asset-finance/deals/deal-1"));expect((await verifyPageResponse(a, "/portal/applications/app-1")).ok).toBe(false);expect(a.get).toHaveBeenCalledTimes(1)
  })
  it.each([body(307, "/login"), body(403), body(404), body(500), body(200, undefined, "application/json", "{}"), body(200, undefined, "text/html", "Application error")])("rejects a bad destination response", async response => {
    const a = actor(body(307, "/asset-finance/deals/deal-1"), response);expect((await verifyPageResponse(a, "/applications/app-1", "/asset-finance/deals/deal-1")).ok).toBe(false)
  })
  it("keeps ordinary consumer HTML200 and error detection", async () => {
    expect((await verifyPageResponse(actor(body()), "/applications/consumer")).ok).toBe(true)
    expect((await verifyPageResponse(actor(body(200, undefined, "text/html", "Internal Server Error")), "/applications/consumer")).ok).toBe(false)
  })
})
