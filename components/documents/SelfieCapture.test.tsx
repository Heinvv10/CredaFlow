import { act, create, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { SelfieCapture } from "./SelfieCapture"

// Fair Score audit 2026-10-16: a desktop with no camera showed "Camera
// unavailable — No camera found" and an unlabeled button, with no way forward.

const g = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
let renderer!: ReactTestRenderer

function textOf(node: unknown): string {
  if (typeof node === "string" || typeof node === "number") return String(node)
  if (Array.isArray(node)) return node.map(textOf).join("")
  if (node && typeof node === "object" && "props" in node) return textOf((node as { props: { children?: unknown } }).props.children)
  return ""
}

function buttonText(label: string) {
  return renderer.root.findAllByType("button").find((b) => textOf(b.props.children).includes(label))
}

beforeEach(() => {
  g.IS_REACT_ACT_ENVIRONMENT = true
  vi.stubGlobal("navigator", {
    mediaDevices: { getUserMedia: vi.fn(async () => { throw Object.assign(new Error("Requested device not found"), { name: "NotFoundError" }) }) },
  })
})
afterEach(async () => {
  await act(async () => renderer.unmount())
  vi.unstubAllGlobals()
  delete g.IS_REACT_ACT_ENVIRONMENT
})

describe("SelfieCapture without a camera", () => {
  it("explains in plain words, labels its button and offers the phone hand-off", async () => {
    await act(async () => {
      renderer = create(<SelfieCapture onCapture={vi.fn()} fallback={<a href="#phone">Continue on your phone</a>} />)
    })
    await act(async () => { await buttonText("Open Camera")!.props.onClick() })

    const html = JSON.stringify(renderer.toJSON())
    expect(html).toContain("We couldn't find a camera on this device")
    expect(html).not.toContain("Requested device not found")
    const retry = buttonText("Try again")!
    expect(retry.props["aria-label"]).toBe("Try the camera again")
    expect(html).toContain("Continue on your phone")
  })
})
