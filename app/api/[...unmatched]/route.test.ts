import { describe, expect, it } from "vitest"
import * as route from "./route"

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"] as const

describe("unmatched API catch-all", () => {
  it("answers every method with a JSON 404, never an HTML error page", async () => {
    for (const method of METHODS) {
      const handler = route[method]
      expect(handler, `${method} handler must exist`).toBeTypeOf("function")
      const res = handler()
      expect(res.status).toBe(404)
      expect(res.headers.get("content-type")).toContain("application/json")
      expect(await res.json()).toEqual({ error: "Not found" })
    }
  })
})
