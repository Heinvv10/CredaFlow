import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SigningOtpStep } from "./SigningOtpStep"

const DIGEST = "a".repeat(64)
const fetchMock = vi.fn()
vi.stubGlobal("fetch", fetchMock)

const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body })
const text = (node: ReactTestInstance): string =>
  node.children.map((c) => (typeof c === "string" ? c : text(c))).join("")
const button = (r: ReactTestRenderer, label: RegExp) =>
  r.root.findAll((n) => n.type === "button").find((b) => label.test(text(b)))!

async function mount(onVerified = vi.fn(), channels: ("EMAIL" | "WHATSAPP")[] = ["EMAIL", "WHATSAPP"]) {
  let r: ReactTestRenderer
  await act(async () => {
    r = create(<SigningOtpStep purpose="AGREEMENT" subjectId="app-1" documentSha256={DIGEST} channels={channels} onVerified={onVerified} />)
  })
  return r!
}

afterEach(() => fetchMock.mockReset())

describe("SigningOtpStep", () => {
  it("marks the code field invalid and points it at the refusal alert only when told to", async () => {
    const issue = async (alertId?: string) => {
      let r!: ReactTestRenderer
      await act(async () => {
        r = create(<SigningOtpStep purpose="AGREEMENT" subjectId="app-1" documentSha256={DIGEST} channels={["EMAIL"]} onVerified={vi.fn()} refusedAlertId={alertId} />)
      })
      fetchMock.mockResolvedValueOnce(json(200, { challengeId: "otp-1", channel: "EMAIL", maskedDestination: "s***@example.test" }))
      await act(async () => { button(r, /email/).props.onClick() })
      return r.root.findByProps({ "aria-label": "One-time code" }).props
    }
    const marked = await issue("alert-x")
    expect(marked["aria-invalid"]).toBe(true)
    expect(marked["aria-describedby"]).toBe("alert-x")
    const plain = await issue()
    expect(plain["aria-invalid"]).toBeUndefined()
    expect(plain["aria-describedby"]).toBeUndefined()
  })

  it("offers exactly the channels it was given — never SMS", async () => {
    const r = await mount(vi.fn(), ["EMAIL"])
    const labels = r.root.findAll((n) => n.type === "button").map(text)
    expect(labels).toEqual(["Send code by email"])
  })

  it("requests a code for the exact bytes on screen, verifies it, and hands the challenge to the signing form", async () => {
    const onVerified = vi.fn()
    const r = await mount(onVerified)
    fetchMock.mockResolvedValueOnce(json(200, { challengeId: "otp-1", channel: "WHATSAPP", maskedDestination: "+27 *** *** 4567" }))
    await act(async () => { button(r, /WhatsApp/).props.onClick() })

    expect(fetchMock).toHaveBeenCalledWith("/api/signing-otp", expect.objectContaining({ method: "POST" }))
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      purpose: "AGREEMENT", subjectId: "app-1", documentSha256: DIGEST, channel: "WHATSAPP",
    })
    expect(text(r.root.findByType("section"))).toContain("+27 *** *** 4567")

    await act(async () => { r.root.findByProps({ "aria-label": "One-time code" }).props.onChange({ target: { value: "12 34 56" } }) })
    fetchMock.mockResolvedValueOnce(json(200, { verified: true }))
    await act(async () => { r.root.findByType("form").props.onSubmit({ preventDefault: () => {} }) })

    expect(fetchMock).toHaveBeenLastCalledWith("/api/signing-otp/otp-1/verify", expect.objectContaining({ body: JSON.stringify({ code: "123456" }) }))
    expect(onVerified).toHaveBeenLastCalledWith("otp-1")
    expect(text(r.root.findByType("section"))).toContain("Code verified")
  })

  it("does not unlock signing on a wrong code, and shows why", async () => {
    const onVerified = vi.fn()
    const r = await mount(onVerified)
    fetchMock.mockResolvedValueOnce(json(200, { challengeId: "otp-1", channel: "EMAIL", maskedDestination: "a***@e***.invalid" }))
    await act(async () => { button(r, /email/).props.onClick() })
    await act(async () => { r.root.findByProps({ "aria-label": "One-time code" }).props.onChange({ target: { value: "000000" } }) })
    fetchMock.mockResolvedValueOnce(json(400, { error: "That code is not correct.", signingOtp: "wrong_code" }))
    await act(async () => { r.root.findByType("form").props.onSubmit({ preventDefault: () => {} }) })

    expect(onVerified).not.toHaveBeenCalledWith("otp-1")
    expect(text(r.root.findByType("section"))).toContain("That code is not correct.")
  })

  it("tells the borrower when there is nowhere to send a code", async () => {
    const r = await mount(vi.fn(), [])
    expect(text(r.root.findByType("section"))).toContain("no email address or WhatsApp number on file")
  })
})
