import { beforeEach, describe, expect, it, vi } from "vitest"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"

const { readFileMock } = vi.hoisted(() => ({ readFileMock: vi.fn() }))

vi.mock("@/lib/storage", () => ({
  readFile: (...args: unknown[]) => readFileMock(...args),
}))

import { verifyPasqDocumentArtifact } from "./pasq-document.server"

const bytes = Buffer.from("%PDF-1.4 exact PASQ")
const documentSha256 = sha256DocumentBytes(bytes)
const args = {
  tenantId: "tenant-1",
  clientId: "client-1",
  documentId: "pasq-1",
  documentSha256,
}

function db() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ id: "pasq-1" }]),
    clientDocument: {
      findFirst: vi.fn().mockResolvedValue({
        id: "pasq-1",
        storagePath: "/pasq/pasq-1.pdf",
        contentSha256: documentSha256,
      }),
    },
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  readFileMock.mockResolvedValue(bytes)
})

describe("verifyPasqDocumentArtifact", () => {
  it("locks, reads, and verifies the exact application-bound PASQ", async () => {
    const store = db()

    const result = await verifyPasqDocumentArtifact(store as never, { ...args, lock: true })

    expect(result.ok).toBe(true)
    expect(store.$queryRaw).toHaveBeenCalledOnce()
    const lockQuery = store.$queryRaw.mock.calls[0]?.[0] as { strings: string[] }
    expect(lockQuery.strings.join("?")).toContain(
      `'FORM_20_PRE_AGREEMENT'::"DocType"`,
    )
    expect(store.clientDocument.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: "pasq-1",
        tenantId: "tenant-1",
        clientId: "client-1",
        docType: "FORM_20_PRE_AGREEMENT",
        contentSha256: documentSha256,
      }),
      select: { id: true, storagePath: true, contentSha256: true },
    })
  })

  it("fails closed when the document row cannot be locked", async () => {
    const store = db()
    store.$queryRaw.mockResolvedValue([])

    await expect(verifyPasqDocumentArtifact(store as never, { ...args, lock: true }))
      .resolves.toEqual({ ok: false, reason: "missing" })
    expect(store.clientDocument.findFirst).not.toHaveBeenCalled()
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("fails closed when the managed bytes are unavailable or tampered", async () => {
    const store = db()
    readFileMock.mockRejectedValueOnce(new Error("storage unavailable"))
    await expect(verifyPasqDocumentArtifact(store as never, args))
      .resolves.toEqual({ ok: false, reason: "bytes_unavailable" })

    readFileMock.mockResolvedValueOnce(Buffer.from("tampered"))
    await expect(verifyPasqDocumentArtifact(store as never, args))
      .resolves.toEqual({ ok: false, reason: "hash_mismatch" })
  })
})
