// @vitest-environment jsdom
// A real DOM: focus, scrollIntoView and aria attributes cannot be read off
// react-test-renderer, whose refs are null.
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { PortalAgreementClient } from "./PortalAgreementClient"
import { AGREEMENT_DECLARATIONS } from "@/lib/signing/agreement-declaration-set"

vi.mock("@/lib/toast", () => ({ toast: {} }))
vi.mock("@/components/signing/SigningOtpStep", () => ({
  SigningOtpStep: ({ refusedAlertId, onVerified }: { refusedAlertId?: string; onVerified: (id: string | null) => void }) => (
    <div><input data-testid="otp" aria-invalid={refusedAlertId ? true : undefined} aria-describedby={refusedAlertId} /><button data-testid="verify" onClick={() => onVerified("otp-1")}>verify</button></div>
  ),
}))

const actEnvironment = globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }

let container: HTMLDivElement
let root: Root
let scrollMock: ReturnType<typeof vi.fn>
let fetchMock: ReturnType<typeof vi.fn>
let reducedMotion = false

async function mount(signingOtp?: { required: boolean; channels: [] }) {
  await act(async () => root.render(
    <PortalAgreementClient applicationId="synthetic" reference="SYNTHETIC" clientName="Synthetic"
      agreementDocumentSha256={"a".repeat(64)} agreementExecutedDocumentId={null}
      pasqDocumentSha256={"b".repeat(64)} repaymentMethod="EFT" signingOtp={signingOtp} />,
  ))
}

beforeEach(() => {
  actEnvironment.IS_REACT_ACT_ENVIRONMENT = true
  reducedMotion = false
  scrollMock = vi.fn()
  fetchMock = vi.fn(async () => ({ ok: true }))
  vi.stubGlobal("fetch", fetchMock)
  Element.prototype.scrollIntoView = scrollMock as unknown as Element["scrollIntoView"]
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: reducedMotion && query.includes("reduce"), media: query }))
  HTMLCanvasElement.prototype.getContext = (() => null) as unknown as HTMLCanvasElement["getContext"]
  container = document.createElement("div")
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(async () => {
  await act(async () => root.unmount())
  container.remove()
  vi.unstubAllGlobals()
  delete actEnvironment.IS_REACT_ACT_ENVIRONMENT
})

const boxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'))
const alerts = () => Array.from(container.querySelectorAll<HTMLElement>('[role="alert"],[role="status"]'))
const signButton = () => Array.from(container.querySelectorAll("button")).find(b => b.textContent?.includes("I Accept and Sign Digitally"))!
async function click(el: HTMLElement) { await act(async () => el.click()) }
async function tick(i: number) { await click(boxes()[i]) }
async function typeName(value: string) {
  await click(Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Type")!)
  const input = container.querySelector<HTMLInputElement>('input[type="text"]')!
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })) })
}

describe("unticked declarations", () => {
  it("shows a short alert, marks the unticked boxes and focuses the first", async () => {
    await mount()
    await tick(0)
    await click(signButton())
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0].textContent).toBe("4 declarations still need to be ticked")
    for (const d of AGREEMENT_DECLARATIONS) expect(alerts()[0].textContent).not.toContain(d.text)
    expect(boxes()[0].getAttribute("aria-invalid")).toBeNull()
    for (const b of boxes().slice(1)) {
      expect(b.getAttribute("aria-invalid")).toBe("true")
      expect(b.getAttribute("aria-describedby")).toBe(alerts()[0].id)
    }
    expect(document.activeElement).toBe(boxes()[1])
    expect(scrollMock).toHaveBeenCalledWith({ block: "center", behavior: "smooth" })
  })

  it("uses the singular for one and keeps the declaration text visible", async () => {
    await mount()
    for (const i of [0, 1, 2, 3]) await tick(i)
    await click(signButton())
    expect(alerts()[0].textContent).toBe("1 declaration still needs to be ticked")
    expect(container.textContent).toContain(AGREEMENT_DECLARATIONS[4].text)
  })

  it("scrolls instantly when the user prefers reduced motion", async () => {
    reducedMotion = true
    await mount()
    await click(signButton())
    expect(scrollMock).toHaveBeenCalledWith({ block: "center", behavior: "auto" })
  })

  it("clears the alert and the marks once everything is ticked", async () => {
    await mount()
    await click(signButton())
    for (const i of [0, 1, 2, 3, 4]) await tick(i)
    expect(alerts()).toHaveLength(0)
    expect(boxes().every(b => b.getAttribute("aria-invalid") === null)).toBe(true)
  })
})

describe("signature and one-time code alerts", () => {
  it("shows no signature alert until a click fails on the signature", async () => {
    await mount()
    await click(signButton())
    expect(alerts().map(a => a.textContent).join()).not.toContain("signature")
    for (const i of [0, 1, 2, 3, 4]) await tick(i)
    expect(alerts()).toHaveLength(0)
    await click(signButton())
    expect(alerts()).toHaveLength(1)
    expect(alerts()[0].textContent).toBe("Please add your signature above before signing.")
    expect(scrollMock).toHaveBeenCalledTimes(1) // only the declarations click scrolled
  })

  it("drops the signature alert once a signature is added", async () => {
    await mount()
    for (const i of [0, 1, 2, 3, 4]) await tick(i)
    await click(signButton())
    await typeName("Synthetic Signer")
    expect(alerts()).toHaveLength(0)
  })

  it("asks for the one-time code only after a click that failed on it, and sends nothing", async () => {
    await mount({ required: true, channels: [] })
    await typeName("Synthetic Signer")
    for (const i of [0, 1, 2, 3, 4]) await tick(i)
    expect(alerts()).toHaveLength(0)
    await click(signButton())
    expect(alerts()[0].textContent).toBe("Please verify the one-time code above before signing.")
    expect(fetchMock).not.toHaveBeenCalled()
    const otp = container.querySelector('[data-testid="otp"]')!
    expect(otp.getAttribute("aria-invalid")).toBe("true")
    expect(otp.getAttribute("aria-describedby")).toBe(alerts()[0].id)
  })

  it("sends nothing while the signature is missing, and marks the typed-name field", async () => {
    await mount()
    for (const i of [0, 1, 2, 3, 4]) await tick(i)
    await click(Array.from(container.querySelectorAll("button")).find(b => b.textContent === "Type")!)
    await click(signButton())
    expect(fetchMock).not.toHaveBeenCalled()
    const input = container.querySelector('input[type="text"]')!
    expect(input.getAttribute("aria-invalid")).toBe("true")
    expect(input.getAttribute("aria-describedby")).toBe(alerts()[0].id)
  })

  it("sends nothing while declarations are unticked", async () => {
    await mount()
    await click(signButton())
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("does not bring an alert back when its problem is fixed and then undone", async () => {
    await mount({ required: true, channels: [] })
    await click(signButton())
    for (const i of [0, 1, 2, 3, 4]) await tick(i)
    await tick(2) // un-tick: no click since, so no alert
    expect(alerts()).toHaveLength(0)
    await tick(2)
    await typeName("Synthetic Signer")
    await click(signButton()) // refused on the OTP
    expect(alerts()).toHaveLength(1)
    await click(container.querySelector<HTMLElement>('[data-testid="verify"]')!)
    expect(alerts()).toHaveLength(0)
    await typeName("") // un-fix the signature: still no click, still no alert
    expect(alerts()).toHaveLength(0)
  })

  it("does not bring the signature alert back after the signature is cleared", async () => {
    await mount()
    for (const i of [0, 1, 2, 3, 4]) await tick(i)
    await click(signButton())
    await typeName("Synthetic Signer")
    expect(alerts()).toHaveLength(0)
    await typeName("")
    expect(alerts()).toHaveLength(0)
  })

  it("announces the declarations count politely rather than as an assertive alert", async () => {
    await mount()
    await click(signButton())
    expect(container.querySelector('[role="alert"]')).toBeNull()
    const status = container.querySelector('[role="status"]')!
    expect(status.getAttribute("aria-live")).toBe("polite")
  })
})
