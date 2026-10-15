import { describe, expect, it } from "vitest"
import { isPdf, parseRmcpFields, rmcpReviewState } from "./rmcp"

const now = new Date("2026-10-14T10:00:00.000Z")

describe("RMCP", () => {
  it("dates the review: current, due within 30 days, overdue", () => {
    expect(rmcpReviewState(new Date("2027-06-01"), now)).toBe("CURRENT")
    expect(rmcpReviewState(new Date("2026-11-01"), now)).toBe("DUE_SOON")
    expect(rmcpReviewState(new Date("2026-10-01"), now)).toBe("OVERDUE")
  })

  it("accepts only a PDF by its bytes", () => {
    expect(isPdf(Buffer.from("%PDF-1.7\n..."))).toBe(true)
    expect(isPdf(Buffer.from("<html>not a pdf</html>"))).toBe(false)
    expect(isPdf(Buffer.alloc(0))).toBe(false)
  })

  it("requires a title and a future review date", () => {
    expect(parseRmcpFields("RMCP v3", "2027-10-14", now)).toMatchObject({ ok: true })
    expect(parseRmcpFields("", "2027-10-14", now).ok).toBe(false)
    expect(parseRmcpFields("RMCP v3", "2026-01-01", now).ok).toBe(false)
    expect(parseRmcpFields("RMCP v3", "14/10/2027", now).ok).toBe(false)
  })
})
