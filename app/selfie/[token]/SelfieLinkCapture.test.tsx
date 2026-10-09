import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it, vi } from "vitest"
import { SelfieLinkCapture, uploadSelfieCapture } from "./SelfieLinkCapture"

vi.mock("@/components/documents/SelfieCapture", () => ({
  SelfieCapture: () => <div data-testid="capture" />,
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("SelfieLinkCapture", () => {
  it("greets the consumer by first name and states what the photo is for", () => {
    const html = renderToStaticMarkup(<SelfieLinkCapture token="t" firstName="Thabo" />)

    expect(html).toContain("Thabo")
    expect(html).toContain("photo of your face")
    expect(html).toContain("ID document")
  })

  it("renders the capture control", () => {
    const html = renderToStaticMarkup(<SelfieLinkCapture token="t" firstName="Thabo" />)

    expect(html).toContain("data-testid=\"capture\"")
  })

  it("does not put the application or client id on the page", () => {
    // The component is given neither, by design: the page resolves the token
    // server-side and passes only what the consumer needs to see. This asserts
    // the prop surface stays that narrow.
    const html = renderToStaticMarkup(<SelfieLinkCapture token="tok-secret" firstName="Thabo" />)

    expect(html).not.toContain("applicationId")
    expect(html).not.toContain("clientId")
  })
})

describe("uploadSelfieCapture", () => {
  function stubFetch(handler: (url: string) => Response | Promise<Response>) {
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, _init?: RequestInit) => handler(String(input)),
    )
    vi.stubGlobal("fetch", fetchMock)
    return fetchMock
  }

  const file = new File([new Uint8Array([1])], "s.jpg", { type: "image/jpeg" })

  it("posts the image to the token's capture endpoint as multipart form data", async () => {
    const fetchMock = stubFetch((url) =>
      url === "/api/selfie-link/tok1/capture"
        ? new Response(JSON.stringify({ ok: true }), { status: 200 })
        : new Response("unexpected url", { status: 500 }),
    )

    const result = await uploadSelfieCapture("tok1", file)

    expect(result).toEqual({ ok: true })
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(init.method).toBe("POST")
    expect(init.body).toBeInstanceOf(FormData)
    expect((init.body as FormData).get("image")).toBe(file)
  })

  it("surfaces the server's own refusal wording, not a generic message", async () => {
    stubFetch(() =>
      new Response(
        JSON.stringify({ error: "This link has expired. Ask your consultant to send a new one." }),
        { status: 410 },
      ),
    )

    const result = await uploadSelfieCapture("tok1", file)

    expect(result).toEqual({
      ok: false,
      error: "This link has expired. Ask your consultant to send a new one.",
    })
  })

  it("falls back to a plain message when the server sends no error body", async () => {
    stubFetch(() => new Response("not json", { status: 500 }))

    const result = await uploadSelfieCapture("tok1", file)

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/try again/i)
  })

  it("reports a network failure rather than throwing at the consumer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Failed to fetch") }))

    const result = await uploadSelfieCapture("tok1", file)

    expect(result.ok).toBe(false)
    expect((result as { error: string }).error).toMatch(/network/i)
  })

  it("does not put the token in the request body, only in the path", async () => {
    const fetchMock = stubFetch(() => new Response(JSON.stringify({ ok: true }), { status: 200 }))

    await uploadSelfieCapture("tok-secret-value", file)

    const url = String(fetchMock.mock.calls[0][0])
    const init = fetchMock.mock.calls[0][1] as RequestInit
    expect(url).toContain("tok-secret-value")
    expect((init.body as FormData).get("token")).toBeNull()
  })
})
