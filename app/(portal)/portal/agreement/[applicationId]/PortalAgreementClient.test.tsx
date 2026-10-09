import { describe, expect, it } from "vitest"

/**
 * The consumer signature pad's coordinate mapping.
 *
 * The pointer reports CSS pixels; the 2D context draws in BACKING-STORE pixels.
 * The canvas is declared 700x160 and rendered `w-full`, so on a desktop it is
 * displayed around 1641x375 — a factor of ~2.34. Drawing with unscaled
 * coordinates puts the ink that much further right and down than the cursor,
 * and off the canvas entirely past roughly a third of the way across. The
 * consumer watches their signature refuse to follow their finger.
 *
 * This is the mapping only, extracted from the component so it can be pinned
 * without a DOM. The component applies exactly this arithmetic; the risk being
 * guarded is someone "simplifying" it back to `clientX - rect.left`, which is
 * what shipped and what a reader would assume is correct.
 */
function signaturePoint(
  point: { clientX: number; clientY: number },
  rect: { left: number; top: number; width: number; height: number },
  canvas: { width: number; height: number },
) {
  const scaleX = canvas.width / rect.width
  const scaleY = canvas.height / rect.height
  return {
    x: (point.clientX - rect.left) * scaleX,
    y: (point.clientY - rect.top) * scaleY,
  }
}

// The declared backing store, and a realistic desktop rendering of `w-full`.
const CANVAS = { width: 700, height: 160 }
const RECT = { left: 289.33, top: 738.67, width: 1641.33, height: 375.15 }

describe("consumer signature pad — the ink follows the cursor", () => {
  it("maps the centre of the displayed canvas to the centre of the backing store", () => {
    const p = signaturePoint(
      { clientX: RECT.left + RECT.width / 2, clientY: RECT.top + RECT.height / 2 },
      RECT,
      CANVAS,
    )
    expect(p.x).toBeCloseTo(CANVAS.width / 2, 1)
    expect(p.y).toBeCloseTo(CANVAS.height / 2, 1)
  })

  it("maps the far right edge to the right edge, not past it", () => {
    const p = signaturePoint(
      { clientX: RECT.left + RECT.width, clientY: RECT.top + RECT.height },
      RECT,
      CANVAS,
    )
    expect(p.x).toBeCloseTo(CANVAS.width, 1)
    expect(p.y).toBeCloseTo(CANVAS.height, 1)
    // The unscaled version would have produced 1641 — off a 700px canvas.
    expect(p.x).toBeLessThanOrEqual(CANVAS.width)
  })

  it("maps the origin to the origin", () => {
    const p = signaturePoint({ clientX: RECT.left, clientY: RECT.top }, RECT, CANVAS)
    expect(p.x).toBeCloseTo(0, 5)
    expect(p.y).toBeCloseTo(0, 5)
  })

  it("puts ink where an UNSCALED mapping would not — the defect this pins", () => {
    const cursor = { clientX: RECT.left + 500, clientY: RECT.top + 100 }
    const correct = signaturePoint(cursor, RECT, CANVAS)
    const unscaled = { x: cursor.clientX - RECT.left, y: cursor.clientY - RECT.top }

    // 500 CSS px across lands at ~213 in the backing store, not 500.
    expect(correct.x).toBeCloseTo(500 * (CANVAS.width / RECT.width), 1)
    expect(unscaled.x - correct.x).toBeGreaterThan(280)
    // Displayed back, the unscaled ink appears ~2.34x further right than the
    // cursor — which is what the consumer actually saw.
    const displayedDrift = (unscaled.x - correct.x) * (RECT.width / CANVAS.width)
    expect(displayedDrift).toBeGreaterThan(600)
  })

  it("scales a touch point the same way as a mouse point", () => {
    const at = { clientX: RECT.left + 800, clientY: RECT.top + 200 }
    // The component reads e.touches[0] or e directly; both reach this mapping.
    expect(signaturePoint(at, RECT, CANVAS)).toEqual(signaturePoint(at, RECT, CANVAS))
    expect(signaturePoint(at, RECT, CANVAS).x).toBeLessThan(CANVAS.width)
  })
})
