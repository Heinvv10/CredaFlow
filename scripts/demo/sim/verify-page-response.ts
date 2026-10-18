import type { ApiResponse, SimClient } from "./api"
const ERROR_MARKERS = ["Application error", "Internal Server Error", "This page could not be found"]
export async function verifyPageResponse(actor: Pick<SimClient, "baseUrl" | "get">, page: string, expectedDealPath?: string): Promise<{ ok: boolean; response: ApiResponse; destination?: string }> {
  let response = await actor.get(page, { headers: { accept: "text/html" }, expect: [200, 302, 303, 307, 308, 401, 403, 404, 500] })
  if (expectedDealPath !== undefined && (response.status !== 307 || !/^\/applications\/[^/?#]+$/.test(page) || !/^\/asset-finance\/deals\/[^/?#]+$/.test(expectedDealPath))) {
    return { ok: false, response }
  }
  let destination: string | undefined
  if (response.status === 307 && expectedDealPath && /^\/applications\/[^/?#]+$/.test(page) && /^\/asset-finance\/deals\/[^/?#]+$/.test(expectedDealPath)) {
    const location = response.headers.get("location")
    const expected = new URL(expectedDealPath, actor.baseUrl)
    // No generic redirect following: auth, external, alternate-deal and
    // noncanonical query/fragment destinations remain failures.
    if (location === expectedDealPath || location === expected.href) {
      destination = expectedDealPath
      response = await actor.get(destination, { headers: { accept: "text/html" }, expect: [200, 302, 303, 307, 308, 401, 403, 404, 500] })
    }
  }
  return { destination, ok: response.status === 200 && (response.headers.get("content-type") ?? "").includes("text/html") && !ERROR_MARKERS.some(marker => response.text.includes(marker)), response }
}
