import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { NextRequest } from "next/server"
import { verifyCronSecret } from "./cron-auth"

const SECRET = "correct-horse-battery"
const req = (secret?: string) =>
  new NextRequest("http://localhost/api/cron/x", secret === undefined ? {} : { headers: { "x-cron-secret": secret } })

describe("verifyCronSecret", () => {
  const original = process.env.CRON_SECRET
  beforeEach(() => {
    process.env.CRON_SECRET = SECRET
  })
  afterEach(() => {
    if (original === undefined) delete process.env.CRON_SECRET
    else process.env.CRON_SECRET = original
  })

  it("lets the right secret through", () => {
    expect(verifyCronSecret(req(SECRET))).toBeNull()
  })

  it("refuses a missing header with 401", async () => {
    const denied = verifyCronSecret(req())
    expect(denied?.status).toBe(401)
  })

  it("refuses a wrong secret of a different length with 401", () => {
    expect(verifyCronSecret(req("nope"))?.status).toBe(401)
  })

  it("refuses a wrong secret of the SAME length with 401 (the timing-safe comparison, not the length check)", () => {
    const sameLength = "x".repeat(SECRET.length)
    expect(sameLength).toHaveLength(SECRET.length)
    expect(verifyCronSecret(req(sameLength))?.status).toBe(401)
  })

  it("refuses everything with 500 when CRON_SECRET is not configured, even an empty header", async () => {
    delete process.env.CRON_SECRET
    for (const request of [req(), req(""), req("anything")]) {
      const denied = verifyCronSecret(request)
      expect(denied?.status).toBe(500)
      expect(await denied?.json()).toEqual({ error: "CRON_SECRET not configured" })
    }
  })
})
