import { describe, expect, it } from "vitest"
import { complaintActionBody, complaintStatusLabel, complaintTiles, nextComplaintActions } from "./status-flow"

describe("complaint status flow", () => {
  // Fair Score audit 2026-10-16: no Acknowledged or Resolved option from Open.
  it("offers Acknowledged and Resolved on an open complaint", () => {
    const next = nextComplaintActions({ status: "OPEN", acknowledgedAt: null })
    expect(next[0]).toBe("ACKNOWLEDGE")
    expect(next).toContain("RESOLVED")
    expect(complaintActionBody("ACKNOWLEDGE")).toEqual({ acknowledge: true })
    expect(complaintActionBody("RESOLVED")).toEqual({ status: "RESOLVED" })
  })

  it("reads an acknowledged open complaint as Acknowledged and stops offering it", () => {
    const complaint = { status: "OPEN", acknowledgedAt: "2026-10-16T10:00:00.000Z" }
    expect(complaintStatusLabel(complaint)).toBe("Acknowledged")
    expect(nextComplaintActions(complaint)).not.toContain("ACKNOWLEDGE")
    expect(complaintStatusLabel({ status: "OPEN", acknowledgedAt: null })).toBe("Open")
  })

  it("counts the Escalated tile as both escalated tabs", () => {
    const tiles = complaintTiles([
      { status: "ESCALATED", acknowledgedAt: null },
      { status: "ESCALATED_OMBUD", acknowledgedAt: null },
      { status: "OPEN", acknowledgedAt: null },
    ])
    expect(tiles.find((t) => t.key === "escalated")).toMatchObject({ label: "Escalated (incl. Ombud)", value: 2 })
    expect(tiles.find((t) => t.key === "total")?.value).toBe(3)
  })
})
