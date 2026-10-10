import { afterEach, describe, expect, it, vi } from "vitest"
import { POST } from "./route"

const MAX_FILE_SIZE = 10 * 1024 * 1024 // 10MB — mirrors lib/document-auth

const {
  auth,
  findFirstClient,
  findFirstLoan,
  createDoc,
  createNote,
  saveFile,
  deleteFile,
  logAudit,
} = vi.hoisted(() => ({
  auth: vi.fn(),
  findFirstClient: vi.fn(),
  findFirstLoan: vi.fn(),
  createDoc: vi.fn(),
  createNote: vi.fn(),
  saveFile: vi.fn(),
  deleteFile: vi.fn(),
  logAudit: vi.fn(),
}))

const tx = {
  clientDocument: { create: createDoc },
  loanNote: { create: createNote },
}

vi.mock("@/lib/auth", () => ({ auth }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: findFirstClient },
    loan: { findFirst: findFirstLoan },
    clientDocument: { create: createDoc },
    loanNote: { create: createNote },
    $transaction: (fn: (t: typeof tx) => unknown) => fn(tx),
  },
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }),
}))
vi.mock("@/lib/storage", () => ({ saveFile, deleteFile }))
vi.mock("@/lib/audit", () => ({
  logAudit,
  AuditAction: { DOCUMENT_UPLOADED: "DOCUMENT_UPLOADED" },
}))
vi.mock("@/lib/rate-limit", () => ({ callerIp: () => "127.0.0.1" }))

function makeReq(fields: Record<string, string>, file?: File) {
  const form = new FormData()
  for (const [k, v] of Object.entries(fields)) form.append(k, v)
  if (file) form.append("file", file)
  return new Request("http://localhost/api/portal/payment/manual", { method: "POST", body: form })
}

const pdf = () => new File([Buffer.from("%PDF-1.4 test")], "proof.pdf", { type: "application/pdf" })

afterEach(() => { vi.clearAllMocks() })

describe("POST /api/portal/payment/manual", () => {
  it("returns 401 when not signed in", async () => {
    auth.mockResolvedValue(null)
    const res = await POST(makeReq({ loanId: "l1", amount: "10000" }, pdf()))
    expect(res.status).toBe(401)
  })

  it("returns 400 when the proof file is missing", async () => {
    auth.mockResolvedValue({ user: { email: "client@example.com" } })
    const res = await POST(makeReq({ loanId: "l1", amount: "10000" }))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/file is required/i)
  })

  it("returns 400 for a disallowed MIME type", async () => {
    auth.mockResolvedValue({ user: { email: "client@example.com" } })
    const bad = new File([Buffer.from("x")], "p.txt", { type: "text/plain" })
    const res = await POST(makeReq({ loanId: "l1", amount: "10000" }, bad))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/not allowed/i)
  })

  it("returns 400 for an oversize file", async () => {
    auth.mockResolvedValue({ user: { email: "client@example.com" } })
    const big = new File([new Uint8Array(MAX_FILE_SIZE + 1)], "big.pdf", { type: "application/pdf" })
    const res = await POST(makeReq({ loanId: "l1", amount: "10000" }, big))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/too large/i)
  })

  it("returns 404 when the loan is not owned by the client", async () => {
    auth.mockResolvedValue({ user: { email: "client@example.com" } })
    findFirstClient.mockResolvedValue({ id: "c1", firstName: "Pieter", lastName: "van der Berg" })
    findFirstLoan.mockResolvedValue(null)
    const res = await POST(makeReq({ loanId: "l1", amount: "10000" }, pdf()))
    expect(res.status).toBe(404)
    expect(saveFile).not.toHaveBeenCalled()
  })

  it("returns 400 when content does not match the declared type", async () => {
    auth.mockResolvedValue({ user: { email: "client@example.com" } })
    const fake = new File([Buffer.from("GIF89a not a pdf")], "fake.pdf", { type: "application/pdf" })
    const res = await POST(makeReq({ loanId: "l1", amount: "10000" }, fake))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/content does not match/i)
  })

  it("creates a document + linked note on the happy path", async () => {
    auth.mockResolvedValue({ user: { email: "client@example.com" } })
    findFirstClient.mockResolvedValue({ id: "c1", firstName: "Pieter", lastName: "van der Berg" })
    findFirstLoan.mockResolvedValue({ id: "l1", reference: "LN-0005" })
    saveFile.mockResolvedValue({ storagePath: "/uploads/x.pdf", fileSize: 13 })
    createDoc.mockResolvedValue({ id: "doc1" })
    createNote.mockResolvedValue({ id: "note1" })

    const res = await POST(makeReq({ loanId: "l1", amount: "315400", reference: "REF1" }, pdf()))
    expect(res.status).toBe(200)
    expect(saveFile).toHaveBeenCalledOnce()
    expect(createDoc).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ docType: "PROOF_OF_PAYMENT", uploadedByType: "client", uploadedById: "c1", extractionStatus: "skipped" }),
    }))
    expect(createNote).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        type: "manual_payment_claim",
        documentId: "doc1",
        note: expect.stringContaining("R3154.00"),
      }),
    }))
    expect(logAudit).toHaveBeenCalledWith(expect.objectContaining({
      newValue: expect.objectContaining({ amountCents: 315400 }),
    }))
  })
})
