/* eslint-disable @typescript-eslint/no-explicit-any */
import { it, expect, vi, beforeEach } from "vitest"
import { NextRequest } from "next/server"

const requireApiRoleMock = vi.fn()
const generateDocumentMock = vi.fn()

vi.mock("@/lib/auth-guards", () => ({ requireApiRole: (role: unknown) => requireApiRoleMock(role) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (req: unknown, cb: (t: any) => Promise<unknown>) => cb({ id: "t1", name: "T" }) }))
vi.mock("@/lib/documents/render", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/documents/render")>()
  return {
    ...actual,
    generateDocument: (opts: unknown) => generateDocumentMock(opts),
  }
})

import { POST } from "./route"
import {
  MissingTokenError,
  SystemGenerationNotAllowedError,
  TemplateUnavailableError,
} from "@/lib/documents/render"

function req(body: object) {
  return new NextRequest("http://x/api/documents/generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireApiRoleMock.mockResolvedValue({ user: { id: "u1", email: "a@b.c", role: "CREDIT_OFFICER" } })
  generateDocumentMock.mockResolvedValue({ clientDocumentId: "doc1", buffer: Buffer.from("pdf") })
})

it("returns 200 with the clientDocumentId for an authorized staff member", async () => {
  const res = await POST(req({ templateKey: "settlement_letter", clientId: "c1", loanId: "l1" }))
  expect(res.status).toBe(200)

  const body = await res.json()
  expect(body).toEqual({ clientDocumentId: "doc1" })

  expect(requireApiRoleMock).toHaveBeenCalledWith("CREDIT_OFFICER")
  expect(generateDocumentMock).toHaveBeenCalledWith({
    tenantId: "t1",
    templateKey: "settlement_letter",
    clientId: "c1",
    loanId: "l1",
    applicationId: undefined,
    staffUserId: "u1",
    allowSystem: false,
  })
})

it("does not leak the raw PDF buffer in the JSON response", async () => {
  const res = await POST(req({ templateKey: "settlement_letter", clientId: "c1" }))
  const body = await res.json()
  expect(body).not.toHaveProperty("buffer")
  expect(Object.keys(body)).toEqual(["clientDocumentId"])
})

it("returns 422 with the missing token list when generateDocument throws MissingTokenError", async () => {
  generateDocumentMock.mockRejectedValue(new MissingTokenError(["loan.reference"]))

  const res = await POST(req({ templateKey: "settlement_letter", clientId: "c1" }))
  expect(res.status).toBe(422)

  const body = await res.json()
  expect(body).toEqual({ error: "Missing required fields", missing: ["loan.reference"] })
})

it("returns stable 409 JSON when a custom template is not published and available", async () => {
  generateDocumentMock.mockRejectedValue(new TemplateUnavailableError("electronic_application_form"))

  const res = await POST(req({ templateKey: "electronic_application_form", clientId: "c1" }))

  expect(res.status).toBe(409)
  await expect(res.json()).resolves.toEqual({
    error: "This document template is not published and available for generation.",
  })
})

it("returns 403 when generateDocument throws SystemGenerationNotAllowedError (SYSTEM template via generic route)", async () => {
  generateDocumentMock.mockRejectedValue(new SystemGenerationNotAllowedError("credit-agreement"))

  const res = await POST(req({ templateKey: "credit-agreement", clientId: "c1" }))
  expect(res.status).toBe(403)

  const body = await res.json()
  expect(body).toEqual({ error: "System documents must be generated via their dedicated routes" })
})

it("returns 404 when generateDocument throws a not-found error (template)", async () => {
  generateDocumentMock.mockRejectedValue(new Error("Document template not found: tenant=t1 key=bogus"))

  const res = await POST(req({ templateKey: "bogus", clientId: "c1" }))
  expect(res.status).toBe(404)
})

it("returns 404 when generateDocument throws a not-found error (client)", async () => {
  generateDocumentMock.mockRejectedValue(new Error("Client not found: c1"))

  const res = await POST(req({ templateKey: "settlement_letter", clientId: "c1" }))
  expect(res.status).toBe(404)
})

it("rethrows/500s on an unexpected error instead of swallowing it", async () => {
  generateDocumentMock.mockRejectedValue(new Error("boom: storage backend unreachable"))

  await expect(POST(req({ templateKey: "settlement_letter", clientId: "c1" }))).rejects.toThrow(
    "boom: storage backend unreachable"
  )
})

it("returns 403 and does not call generateDocument for an unauthorized/CLIENT session", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Forbidden" }, { status: 403 }) })

  const res = await POST(req({ templateKey: "settlement_letter", clientId: "c1" }))
  expect(res.status).toBe(403)
  expect(generateDocumentMock).not.toHaveBeenCalled()
})

it("returns 401 and does not call generateDocument when unauthenticated", async () => {
  const { NextResponse } = await import("next/server")
  requireApiRoleMock.mockResolvedValue({ error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) })

  const res = await POST(req({ templateKey: "settlement_letter", clientId: "c1" }))
  expect(res.status).toBe(401)
  expect(generateDocumentMock).not.toHaveBeenCalled()
})

it("returns 400 and does not call generateDocument when templateKey is missing", async () => {
  const res = await POST(req({ clientId: "c1" }))
  expect(res.status).toBe(400)
  expect(generateDocumentMock).not.toHaveBeenCalled()
})

it("returns 400 and does not call generateDocument when clientId is missing", async () => {
  const res = await POST(req({ templateKey: "settlement_letter" }))
  expect(res.status).toBe(400)
  expect(generateDocumentMock).not.toHaveBeenCalled()
})
