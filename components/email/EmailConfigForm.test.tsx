/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import TestRenderer, { act } from "react-test-renderer"
import { EmailConfigForm } from "./EmailConfigForm"

const fetchMock = vi.fn()

function textOf(tree: any): string {
  return JSON.stringify(tree)
}

beforeEach(() => {
  fetchMock.mockReset()
  fetchMock.mockResolvedValue({ ok: true, json: async () => null })
  vi.stubGlobal("fetch", fetchMock)
})
afterEach(() => {
  vi.unstubAllGlobals()
})

async function render() {
  let r!: TestRenderer.ReactTestRenderer
  await act(async () => {
    r = TestRenderer.create(<EmailConfigForm />)
  })
  return r
}

describe("EmailConfigForm — Test IMAP", () => {
  it("renders a Test IMAP button beside Send Test Email", async () => {
    const r = await render()
    const labels = r.root.findAllByType("button").map((b) => textOf(b.props.children))
    expect(labels.some((l) => l.includes("Send Test Email"))).toBe(true)
    expect(labels.some((l) => l.includes("Test IMAP"))).toBe(true)
  })

  it("POSTs /api/email/test-imap and shows the returned message", async () => {
    const r = await render()
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ ok: true, message: "Connected to imap.test — INBOX has 3 message(s)." }),
    })
    const btn = r.root
      .findAllByType("button")
      .find((b) => textOf(b.props.children).includes("Test IMAP"))!
    await act(async () => {
      await btn.props.onClick()
    })
    expect(fetchMock).toHaveBeenCalledWith("/api/email/test-imap", { method: "POST" })
    expect(textOf(r.toJSON())).toContain("INBOX has 3 message(s)")
  })

  it("shows the error message on failure", async () => {
    const r = await render()
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ ok: false, message: "Invalid credentials" }) })
    const btn = r.root
      .findAllByType("button")
      .find((b) => textOf(b.props.children).includes("Test IMAP"))!
    await act(async () => {
      await btn.props.onClick()
    })
    expect(textOf(r.toJSON())).toContain("Invalid credentials")
  })

  it("recovers from a rejected fetch: button re-enables and an error is shown", async () => {
    const r = await render()
    fetchMock.mockRejectedValueOnce(new Error("network down"))
    const btn = () =>
      r.root.findAllByType("button").find((b) => textOf(b.props.children).includes("Test IMAP"))!
    await act(async () => {
      await btn().props.onClick()
    })
    expect(btn().props.disabled).toBe(false)
    expect(textOf(r.toJSON())).toContain("Request failed")
  })
})

describe("EmailConfigForm — save()", () => {
  it("shows the server's error message from the JSON body on a failed save", async () => {
    const r = await render()
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: async () => ({ error: "IMAP host imap.other.test is not allowed" }),
    })
    await act(async () => {
      await r.root.findByType("form").props.onSubmit({ preventDefault: () => {} })
    })
    expect(textOf(r.toJSON())).toContain("IMAP host imap.other.test is not allowed")
  })

  it("falls back to a generic message when the failed save has no error body", async () => {
    const r = await render()
    fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({}) })
    await act(async () => {
      await r.root.findByType("form").props.onSubmit({ preventDefault: () => {} })
    })
    expect(textOf(r.toJSON())).toContain("Save failed.")
  })
})

describe("EmailConfigForm — initial config load", () => {
  it("shows an error and clears loading when the initial fetch rejects", async () => {
    fetchMock.mockReset()
    fetchMock.mockRejectedValueOnce(new Error("network down"))
    const r = await render()
    expect(textOf(r.toJSON())).toContain("Could not load email configuration.")
    expect(textOf(r.toJSON())).not.toContain("Loading email configuration")
  })
})
