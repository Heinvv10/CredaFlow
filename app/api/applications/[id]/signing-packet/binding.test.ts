import { createHash } from "node:crypto"
import { PDFDocument } from "pdf-lib"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/**
 * The application binding written when a returned signed packet is uploaded.
 *
 * This is the pointer the client documents folder reads to decide which PDF is
 * the signing packet. Getting it wrong re-creates the failure the card exists to
 * remove — staff acting on the wrong document — so the compare-and-set that
 * guards it needs a test that fails when the guard is weakened.
 *
 * Only auth, tenant, prisma and storage are mocked. The PDFs are real pdf-lib
 * documents and the digests are real sha256 over their bytes, so the page-count
 * gate and the integrity checks run for real.
 */

const {
  requireApiRoleMock,
  applicationFindUniqueMock,
  documentFindFirstMock,
  transactionMock,
  txDocumentCreateMock,
  txApplicationUpdateManyMock,
  txAuditCreateMock,
  readFileMock,
  saveFileMock,
  deleteFileMock,
} = vi.hoisted(() => ({
  requireApiRoleMock: vi.fn(),
  applicationFindUniqueMock: vi.fn(),
  documentFindFirstMock: vi.fn(),
  transactionMock: vi.fn(),
  txDocumentCreateMock: vi.fn(),
  txApplicationUpdateManyMock: vi.fn(),
  txAuditCreateMock: vi.fn(),
  readFileMock: vi.fn(),
  saveFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: (...a: unknown[]) => requireApiRoleMock(...a),
  requireOwnerOrStaff: vi.fn(),
}))
vi.mock("@/lib/tenant", () => ({
  withTenantContext: (_req: unknown, cb: (t: { id: string }) => unknown) =>
    cb({ id: "tenant-1" }),
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: { findUnique: (...a: unknown[]) => applicationFindUniqueMock(...a) },
    clientDocument: { findFirst: (...a: unknown[]) => documentFindFirstMock(...a) },
    $transaction: (...a: unknown[]) => transactionMock(...a),
    documentAccessLog: { create: vi.fn() },
  },
}))
vi.mock("@/lib/storage", () => ({
  readFile: (...a: unknown[]) => readFileMock(...a),
  saveFile: (...a: unknown[]) => saveFileMock(...a),
  deleteFile: (...a: unknown[]) => deleteFileMock(...a),
}))

const { POST } = await import("./route")

const APPLICATION_ID = "app-1"
const CLIENT_ID = "client-1"

async function pdfBytes(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pages; i += 1) pdf.addPage([200, 200])
  return Buffer.from(await pdf.save())
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")

let pasq: Buffer
let agreement: Buffer
let returned: Buffer

/** The binding present on the application BEFORE this upload. */
function application(priorBinding: { id: string | null; sha: string | null }) {
  return {
    clientId: CLIENT_ID,
    status: "APPROVED",
    agreementSignedAt: null,
    pasqDocumentId: "pasq-doc",
    pasqDocumentSha256: sha(pasq),
    agreementDocumentId: "agreement-doc",
    agreementDocumentSha256: sha(agreement),
    signedPacketDocumentId: priorBinding.id,
    signedPacketDocumentSha256: priorBinding.sha,
  }
}

async function upload(): Promise<Response> {
  const form = new FormData()
  form.set("file", new File([new Uint8Array(returned)], "signed.pdf", { type: "application/pdf" }))
  form.set("attestation", "true")
  const req = new NextRequest(
    `http://app.test/api/applications/${APPLICATION_ID}/signing-packet`,
    { method: "POST", body: form },
  )
  return POST(req, { params: Promise.resolve({ id: APPLICATION_ID }) })
}

beforeEach(async () => {
  vi.clearAllMocks()
  pasq = await pdfBytes(4)
  agreement = await pdfBytes(4)
  returned = await pdfBytes(8)

  requireApiRoleMock.mockResolvedValue({
    user: { id: "user-1", email: "officer@acme-lending.example", role: "CREDIT_OFFICER" },
  })
  documentFindFirstMock.mockImplementation((args: { where: { docType: string } }) =>
    args.where.docType === "FORM_20_PRE_AGREEMENT"
      ? { id: "pasq-doc", storagePath: "/s/pasq.pdf", contentSha256: sha(pasq) }
      : { id: "agreement-doc", storagePath: "/s/agreement.pdf", contentSha256: sha(agreement) },
  )
  readFileMock.mockImplementation((path: string) =>
    path === "/s/pasq.pdf" ? pasq : agreement,
  )
  saveFileMock.mockResolvedValue({ storagePath: "/s/returned.pdf", fileSize: returned.length })
  txDocumentCreateMock.mockImplementation((args: { data: Record<string, unknown> }) => args.data)
  txApplicationUpdateManyMock.mockResolvedValue({ count: 1 })
  transactionMock.mockImplementation((cb: (tx: unknown) => unknown) =>
    cb({
      clientDocument: { create: (...a: unknown[]) => txDocumentCreateMock(...a) },
      loanApplication: { updateMany: (...a: unknown[]) => txApplicationUpdateManyMock(...a) },
      auditLog: { create: (...a: unknown[]) => txAuditCreateMock(...a) },
    }),
  )
})

describe("returned signed packet — application binding", () => {
  describe("with no packet bound yet", () => {
    beforeEach(() => {
      applicationFindUniqueMock.mockResolvedValue(application({ id: null, sha: null }))
    })

    it("stores the packet under its own docType, not OTHER", async () => {
      const res = await upload()
      expect(res.status).toBe(200)
      expect(txDocumentCreateMock).toHaveBeenCalledTimes(1)
      const created = txDocumentCreateMock.mock.calls[0][0].data
      expect(created.docType).toBe("SIGNED_AGREEMENT_PACKET")
    })

    it("binds the application to the uploaded packet and its digest", async () => {
      await upload()
      const call = txApplicationUpdateManyMock.mock.calls[0][0]
      const created = txDocumentCreateMock.mock.calls[0][0].data
      expect(call.data.signedPacketDocumentId).toBe(created.id)
      expect(call.data.signedPacketDocumentSha256).toBe(sha(returned))
    })

    // Without this the CAS cannot distinguish "nothing bound yet" from "another
    // upload bound one while we were reading", and the later commit silently
    // wins — a lost update on the pointer the documents folder reads.
    it("pins the PRIOR binding in the compare-and-set", async () => {
      await upload()
      const { where } = txApplicationUpdateManyMock.mock.calls[0][0]
      expect(where).toHaveProperty("signedPacketDocumentId", null)
      expect(where).toHaveProperty("signedPacketDocumentSha256", null)
    })

    // A recorded signature freezes the binding: it becomes the record of WHICH
    // bytes were signed and a later upload must not move it.
    it("pins agreementSignedAt as null so a recorded signature blocks the bind", async () => {
      await upload()
      const { where } = txApplicationUpdateManyMock.mock.calls[0][0]
      expect(where.agreementSignedAt).toBeNull()
    })
  })

  describe("re-uploading a corrected scan", () => {
    beforeEach(() => {
      applicationFindUniqueMock.mockResolvedValue(
        application({ id: "earlier-packet", sha: "b".repeat(64) }),
      )
    })

    // Sequential re-upload is legitimate — the first attempt is often the wrong
    // file. Pinning must not break it.
    it("succeeds and re-points the binding", async () => {
      const res = await upload()
      expect(res.status).toBe(200)
      const call = txApplicationUpdateManyMock.mock.calls[0][0]
      expect(call.where.signedPacketDocumentId).toBe("earlier-packet")
      expect(call.data.signedPacketDocumentId).not.toBe("earlier-packet")
    })
  })

  describe("when the compare-and-set loses", () => {
    beforeEach(() => {
      applicationFindUniqueMock.mockResolvedValue(application({ id: null, sha: null }))
      txApplicationUpdateManyMock.mockResolvedValue({ count: 0 })
    })

    it("refuses with 409 rather than reporting success", async () => {
      const res = await upload()
      expect(res.status).toBe(409)
    })

    it("says nothing was saved and points at the folder", async () => {
      const res = await upload()
      const body = await res.json() as { error?: string }
      expect(body.error).toMatch(/nothing was saved/i)
      expect(body.error).toMatch(/which returned packet is now on file/i)
    })

    // A retry of an upload whose first attempt actually committed lands here
    // too, so the message must not assert that somebody else did it.
    it("does not blame another user for a change it cannot attribute", async () => {
      const res = await upload()
      const body = await res.json() as { error?: string }
      expect(body.error).not.toMatch(/someone else/i)
      expect(body.error).toMatch(/possibly by an earlier attempt of your own/i)
    })

    // The bytes were written to storage before the transaction opened.
    it("deletes the stored file so no orphan is left behind", async () => {
      await upload()
      expect(deleteFileMock).toHaveBeenCalledWith("/s/returned.pdf")
    })
  })

  describe("when the returned packet is short a half", () => {
    beforeEach(async () => {
      applicationFindUniqueMock.mockResolvedValue(application({ id: null, sha: null }))
      returned = await pdfBytes(4)
    })

    it("refuses before writing any binding", async () => {
      const res = await upload()
      expect(res.status).toBe(422)
      expect(txApplicationUpdateManyMock).not.toHaveBeenCalled()
    })
  })
})
