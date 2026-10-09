import { afterEach, describe, it, expect, vi } from "vitest"
import { createWabaTemplate, fetchWabaTemplateStatus } from "./graph-templates"

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

const creds = { wabaId: "WABA1", accessToken: "TOK" }

describe("createWabaTemplate", () => {
  it("POSTs to the WABA message_templates endpoint and returns id+status", async () => {
    vi.stubEnv("WHATSAPP_GRAPH_VERSION", "v23.0")
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ id: "TID", status: "PENDING", category: "UTILITY" }),
    })
    vi.stubGlobal("fetch", fetchSpy)

    const r = await createWabaTemplate(creds, {
      name: "review_ask", language: "en", category: "UTILITY",
      components: [{ type: "BODY", text: "Hi {{1}}", example: { body_text: [["Thabo"]] } }],
    })

    expect(r).toEqual({ id: "TID", status: "PENDING" })
    const [url, init] = fetchSpy.mock.calls[0]
    expect(url).toBe("https://graph.facebook.com/v23.0/WABA1/message_templates")
    expect((init as RequestInit).method).toBe("POST")
    expect((init as RequestInit).headers).toMatchObject({ Authorization: "Bearer TOK" })
  })

  it("throws on a non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "bad name" }))
    await expect(createWabaTemplate(creds, { name: "x", language: "en", category: "UTILITY", components: [] }))
      .rejects.toThrow(/400/)
  })
})

describe("fetchWabaTemplateStatus", () => {
  it("returns the status for the named template", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true, json: async () => ({ data: [{ name: "review_ask", status: "APPROVED", id: "TID" }] }),
    }))
    expect(await fetchWabaTemplateStatus(creds, "review_ask")).toBe("APPROVED")
  })
  it("returns null when the template is not found", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [] }) }))
    expect(await fetchWabaTemplateStatus(creds, "missing")).toBeNull()
  })
})
