import { describe, expect, it, vi } from "vitest"
import { parseAppointAttorney, parseLegalStepFields, parseLegalStepRequest } from "./legal-matter-input"

// document-auth (the upload MIME and magic-byte checks) imports the session helper.
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

const TODAY = "2026-10-15"
const errorsOf = (result: ReturnType<typeof parseLegalStepFields>) => ("errors" in result ? result.errors : {})

describe("parseLegalStepFields", () => {
  it("accepts a plain step and trims the note", () => {
    const result = parseLegalStepFields({ kind: "LETTER_OF_DEMAND", stepDate: "2026-10-01", note: "  sent by courier " }, TODAY, null)
    expect(result).toEqual({ data: expect.objectContaining({ kind: "LETTER_OF_DEMAND", stepDate: "2026-10-01", note: "sent by courier", recovery: null, closeMatter: false }) })
  })

  it("refuses an unknown kind, a bad or future date and an over-long note", () => {
    expect(errorsOf(parseLegalStepFields({ kind: "EVICTION", stepDate: "2026-10-01" }, TODAY, null))).toHaveProperty("kind")
    expect(errorsOf(parseLegalStepFields({ kind: "JUDGMENT", stepDate: "2026-02-30" }, TODAY, null))).toHaveProperty("stepDate")
    expect(errorsOf(parseLegalStepFields({ kind: "JUDGMENT", stepDate: "2026-10-16" }, TODAY, null))).toHaveProperty("stepDate")
    expect(errorsOf(parseLegalStepFields({ kind: "JUDGMENT", stepDate: "2026-10-15", note: "x".repeat(2_001) }, TODAY, null))).toHaveProperty("note")
  })

  it("ties the section 129 record to the S129_SENT kind", () => {
    expect(errorsOf(parseLegalStepFields({ kind: "S129_SENT", stepDate: TODAY }, TODAY, null))).toHaveProperty("section129RecordId")
    expect(errorsOf(parseLegalStepFields({ kind: "JUDGMENT", stepDate: TODAY, section129RecordId: "r1" }, TODAY, null))).toHaveProperty("section129RecordId")
    expect("data" in parseLegalStepFields({ kind: "S129_SENT", stepDate: TODAY, section129RecordId: "r1" }, TODAY, null)).toBe(true)
  })

  it("needs a location and condition for ASSET_RECOVERED only", () => {
    expect(errorsOf(parseLegalStepFields({ kind: "ASSET_RECOVERED", stepDate: TODAY }, TODAY, null))).toEqual(expect.objectContaining({ location: expect.any(String), condition: expect.any(String) }))
    const ok = parseLegalStepFields({ kind: "ASSET_RECOVERED", stepDate: TODAY, location: " Yard 4 ", condition: "Fair" }, TODAY, null)
    expect("data" in ok && ok.data.recovery).toEqual({ location: "Yard 4", condition: "Fair" })
  })

  it("lets only a settled or withdrawn step close the matter", () => {
    expect(errorsOf(parseLegalStepFields({ kind: "JUDGMENT", stepDate: TODAY, closeMatter: true }, TODAY, null))).toHaveProperty("closeMatter")
    const ok = parseLegalStepFields({ kind: "SETTLED", stepDate: TODAY, closeMatter: "true" }, TODAY, null)
    expect("data" in ok && ok.data.closeMatter).toBe(true)
  })
})

describe("parseLegalStepRequest", () => {
  it("reads a JSON body and refuses a non-object", async () => {
    const json = (body: string) => new Request("http://x.test/", { method: "POST", headers: { "content-type": "application/json" }, body })
    expect("data" in await parseLegalStepRequest(json(JSON.stringify({ kind: "JUDGMENT", stepDate: "2026-10-01" })), TODAY)).toBe(true)
    expect(await parseLegalStepRequest(json("null"), TODAY)).toEqual({ errors: { body: expect.any(String) } })
  })

  it("reads multipart fields with a PDF and rejects a file whose bytes are not its type", async () => {
    const send = (file: File) => {
      const form = new FormData()
      form.set("kind", "JUDGMENT")
      form.set("stepDate", "2026-10-01")
      form.set("file", file)
      return parseLegalStepRequest(new Request("http://x.test/", { method: "POST", body: form }), TODAY)
    }
    const pdf = await send(new File([new TextEncoder().encode("%PDF-1.4 synthetic")], "order.pdf", { type: "application/pdf" }))
    expect("data" in pdf && pdf.data.evidence?.docType).toBe("LEGAL_DOCUMENT")
    expect(await send(new File(["not a pdf at all"], "order.pdf", { type: "application/pdf" }))).toEqual({ errors: { file: "File content does not match its type" } })
    expect(await send(new File(["x"], "order.exe", { type: "application/x-msdownload" }))).toEqual({ errors: { file: expect.stringContaining("not allowed") } })
  })
})

describe("parseAppointAttorney", () => {
  it("needs a supplier and a dated, non-future appointment", () => {
    expect(parseAppointAttorney({ supplierId: "sup1", appointedOn: TODAY }, TODAY)).toEqual({ data: { supplierId: "sup1", appointedOn: TODAY } })
    expect("errors" in parseAppointAttorney({ appointedOn: "2026-10-16" }, TODAY) && Object.keys((parseAppointAttorney({ appointedOn: "2026-10-16" }, TODAY) as { errors: object }).errors)).toEqual(["supplierId", "appointedOn"])
    expect("errors" in parseAppointAttorney(null, TODAY)).toBe(true)
  })
})
