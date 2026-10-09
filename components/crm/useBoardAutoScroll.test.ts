import { describe, it, expect } from "vitest"
import { edgeScrollStep, EDGE_ZONE_PX, MAX_STEP_PX } from "@/components/crm/useBoardAutoScroll"

// A browser drag cannot be driven from vitest, so the velocity rule is tested
// directly. Expected values are written as literals rather than recomputed from
// EDGE_ZONE_PX/MAX_STEP_PX — deriving them from the same constants the code
// uses would make the assertions true whatever the formula did.

const LEFT = 0
const RIGHT = 1000

describe("edgeScrollStep", () => {
  it("holds still in the middle of the board", () => {
    expect(edgeScrollStep(500, LEFT, RIGHT)).toBe(0)
  })

  it("scrolls left at full speed at the left edge", () => {
    expect(edgeScrollStep(0, LEFT, RIGHT)).toBe(-18)
  })

  it("scrolls right at full speed at the right edge", () => {
    expect(edgeScrollStep(1000, LEFT, RIGHT)).toBe(18)
  })

  it("ramps: barely inside the zone is the slowest possible step, not the fastest", () => {
    // 1px inside the zone. A constant-velocity rule would return -18 here, so
    // this is what pins the ramp.
    expect(edgeScrollStep(71, LEFT, RIGHT)).toBe(-1)
    expect(edgeScrollStep(929, LEFT, RIGHT)).toBe(1)
  })

  it("ramps to roughly half speed at the middle of the zone", () => {
    expect(edgeScrollStep(36, LEFT, RIGHT)).toBe(-9)
  })

  it("does not scroll exactly at the outer boundary of the zone", () => {
    // THE boundary. `<=` here would start scrolling one pixel early forever,
    // and nothing on screen would look wrong.
    expect(edgeScrollStep(72, LEFT, RIGHT)).toBe(0)
    expect(edgeScrollStep(928, LEFT, RIGHT)).toBe(0)
  })

  it("saturates rather than accelerating when the pointer leaves the board", () => {
    // Reachable: the drag continues past the container. Unclamped, the ratio
    // would keep growing and the board would jump entire columns per frame.
    expect(edgeScrollStep(-5000, LEFT, RIGHT)).toBe(-18)
    expect(edgeScrollStep(6000, LEFT, RIGHT)).toBe(18)
  })

  it("never scrolls a board too narrow to have two distinct edge zones", () => {
    // Both branches would be live at once and the left one would always win,
    // so a right-edge drag would scroll the board backwards.
    expect(edgeScrollStep(10, 0, 100)).toBe(0)
    expect(edgeScrollStep(90, 0, 100)).toBe(0)
    expect(edgeScrollStep(50, 0, 0)).toBe(0)
  })

  it("reads the rect it is given rather than assuming the board starts at 0", () => {
    // The board sits inside a sidebar layout; its left edge is never 0 in the
    // real app.
    expect(edgeScrollStep(320, 320, 1320)).toBe(-18)
    expect(edgeScrollStep(820, 320, 1320)).toBe(0)
  })

  it("exports the tuning constants it documents", () => {
    expect(EDGE_ZONE_PX).toBe(72)
    expect(MAX_STEP_PX).toBe(18)
  })
})
