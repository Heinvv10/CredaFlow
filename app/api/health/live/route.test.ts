import { describe, expect, it } from "vitest"
import { GET } from "./route"

describe("/api/health/live", () => {
  it("answers 200 without touching the database or storage", async () => {
    const response = await GET()
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ status: "ok" })
    expect(response.headers.get("cache-control")).toBe("no-store")
  })
})
