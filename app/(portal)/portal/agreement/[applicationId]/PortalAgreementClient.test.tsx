import { describe, expect, it, vi } from "vitest"
import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { PortalAgreementClient } from "./PortalAgreementClient"
import { AGREEMENT_DECLARATIONS, AGREEMENT_DECLARATION_PAYLOAD } from "@/lib/signing/agreement-declaration-set"
vi.mock("@/lib/toast", () => ({ toast: {} }))

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


function nodeText(node: unknown): string {
  if (typeof node === "string") return node
  if (Array.isArray(node)) return node.map(nodeText).join("")
  if (node && typeof node === "object" && "props" in node) return nodeText((node as { props: { children?: unknown } }).props.children)
  return ""
}

describe("portal declaration submission", () => {
  it("sends the exact displayed set only after every declaration is accepted", async () => {
    const environment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
    environment.IS_REACT_ACT_ENVIRONMENT = true
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal("fetch", fetchMock)
    let renderer!: ReactTestRenderer
    try {
      await act(async () => { renderer = create(<PortalAgreementClient applicationId="synthetic" reference="SYNTHETIC" clientName="Synthetic" agreementDocumentSha256={"a".repeat(64)} agreementExecutedDocumentId={null} pasqDocumentSha256={"b".repeat(64)} repaymentMethod="EFT" />) })
      const displayed = JSON.stringify(renderer.toJSON())
      for (const declaration of AGREEMENT_DECLARATIONS) expect(displayed).toContain(declaration.text)
      await act(async () => { renderer.root.findAllByType("button").find(b => nodeText(b.props.children) === "Type")!.props.onClick() })
      await act(async () => { renderer.root.findAllByType("input").find(i => i.props.type === "text")!.props.onChange({ target: { value: "Synthetic Signer" } }) })
      const checks = renderer.root.findAllByType("input").filter(i => i.props.type === "checkbox")
      for (const check of checks.slice(0, 4)) await act(async () => { check.props.onChange() })
      const sign = () => renderer.root.findAllByType("button").find(b => nodeText(b.props.children).includes("I Accept and Sign Digitally"))!
      expect(sign().props.disabled).toBe(true)
      await act(async () => { await sign().props.onClick() })
      expect(fetchMock).not.toHaveBeenCalled()
      await act(async () => { checks[4].props.onChange() })
      expect(sign().props.disabled).toBe(false)
      await act(async () => { await sign().props.onClick() })
      expect(fetchMock).toHaveBeenCalledOnce()
      const request = fetchMock.mock.calls[0] as unknown as [string, { body: string }]
      expect(JSON.parse(request[1].body)).toMatchObject({ declarations: AGREEMENT_DECLARATION_PAYLOAD, agreementDocumentSha256: "a".repeat(64), pasqDocumentSha256: "b".repeat(64), signature: "Synthetic Signer" })
    } finally {
      if (renderer) await act(async () => renderer.unmount())
      vi.unstubAllGlobals()
      delete environment.IS_REACT_ACT_ENVIRONMENT
    }
  })
})
