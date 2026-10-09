import { describe, it, expect, vi, beforeEach } from "vitest"

const { updateClientDocument, findFirstClientDocument } = vi.hoisted(() => ({
  updateClientDocument: vi.fn(),
  findFirstClientDocument: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: {
      update: updateClientDocument,
      findFirst: findFirstClientDocument,
    },
  },
}))

import { nativeSigner } from "./native"

beforeEach(() => vi.clearAllMocks())

describe("nativeSigner.requestSignature", () => {
  it("sets signatureState:'pending' + signatureRequestedAt and returns a pending SignatureRequest", async () => {
    findFirstClientDocument.mockResolvedValue({ id: "doc1" })
    updateClientDocument.mockResolvedValue({ id: "doc1" })

    const result = await nativeSigner.requestSignature("t1", "doc1", [{ name: "Thabo M" }])

    expect(findFirstClientDocument).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "doc1", tenantId: "t1" } })
    )
    expect(updateClientDocument).toHaveBeenCalledWith({
      where: { id: "doc1", tenantId: "t1" },
      data: expect.objectContaining({
        signatureState: "pending",
        signatureRequestedAt: expect.any(Date),
      }),
    })
    expect(result).toEqual({ ref: "doc1", status: "pending" })
  })

  it("throws and does not update when the document belongs to a different tenant", async () => {
    findFirstClientDocument.mockResolvedValue(null)

    await expect(
      nativeSigner.requestSignature("t1", "doc1", [{ name: "Thabo M" }])
    ).rejects.toThrow(/not found/i)

    expect(findFirstClientDocument).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "doc1", tenantId: "t1" } })
    )
    expect(updateClientDocument).not.toHaveBeenCalled()
  })
})

describe("nativeSigner.getStatus", () => {
  it("scopes the lookup by tenantId", async () => {
    const signedAt = new Date("2026-07-10T12:00:00Z")
    findFirstClientDocument.mockResolvedValue({ signatureState: "signed", signedAt })

    const result = await nativeSigner.getStatus("t1", "doc1")

    expect(findFirstClientDocument).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "doc1", tenantId: "t1" } })
    )
    expect(result).toEqual({ state: "signed", signedAt })
  })

  it("maps a stored 'pending' state", async () => {
    findFirstClientDocument.mockResolvedValue({ signatureState: "pending", signedAt: null })

    const result = await nativeSigner.getStatus("t1", "doc1")

    expect(result).toEqual({ state: "pending", signedAt: null })
  })

  it("maps a null signatureState (never requested) to 'none'", async () => {
    findFirstClientDocument.mockResolvedValue({ signatureState: null, signedAt: null })

    const result = await nativeSigner.getStatus("t1", "doc1")

    expect(result).toEqual({ state: "none", signedAt: null })
  })

  it("resolves to 'none' when the document belongs to a different tenant (not silently leaked)", async () => {
    findFirstClientDocument.mockResolvedValue(null)

    const result = await nativeSigner.getStatus("t1", "doc1")

    expect(findFirstClientDocument).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "doc1", tenantId: "t1" } })
    )
    expect(result).toEqual({ state: "none", signedAt: null })
  })
})
