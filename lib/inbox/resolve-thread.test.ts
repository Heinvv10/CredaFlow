/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from "vitest"
import { resolveOpenThreadForContact } from "./resolve-thread"

function makeTx() {
  return { conversation: { findFirst: vi.fn(), create: vi.fn() } }
}

const now = new Date("2026-08-27T09:00:00.000Z")
const base = { tenantId: "t1", contactId: "ct1", channel: "WHATSAPP" as const, now }

beforeEach(() => vi.clearAllMocks())

describe("resolveOpenThreadForContact", () => {
  it("never puts channel in the where predicate", async () => {
    const tx = makeTx()
    tx.conversation.findFirst.mockResolvedValue({ id: "cv1" })

    await resolveOpenThreadForContact(tx as any, base)

    const where = tx.conversation.findFirst.mock.calls[0][0].where
    expect(where).toEqual({ tenantId: "t1", contactId: "ct1", closedAt: null })
    expect(Object.keys(where)).not.toContain("channel")
  })

  it("orders by lastInboundAt desc nulls last, then id desc", async () => {
    const tx = makeTx()
    tx.conversation.findFirst.mockResolvedValue({ id: "cv1" })

    await resolveOpenThreadForContact(tx as any, base)

    expect(tx.conversation.findFirst.mock.calls[0][0].orderBy).toEqual([
      { lastInboundAt: { sort: "desc", nulls: "last" } },
      { id: "desc" },
    ])
  })

  it("returns the existing open thread without creating one", async () => {
    const tx = makeTx()
    tx.conversation.findFirst.mockResolvedValue({ id: "cv-open" })

    const r = await resolveOpenThreadForContact(tx as any, base)

    expect(r).toEqual({ id: "cv-open", created: false })
    expect(tx.conversation.create).not.toHaveBeenCalled()
  })

  it("reuses an EMAIL thread for a WHATSAPP resolution", async () => {
    const tx = makeTx()
    tx.conversation.findFirst.mockResolvedValue({ id: "cv-email" })

    const r = await resolveOpenThreadForContact(tx as any, { ...base, channel: "WHATSAPP" })

    expect(r).toEqual({ id: "cv-email", created: false })
  })

  it("creates with the requested channel when nothing is open", async () => {
    const tx = makeTx()
    tx.conversation.findFirst.mockResolvedValue(null)
    tx.conversation.create.mockResolvedValue({ id: "cv-new" })

    const r = await resolveOpenThreadForContact(tx as any, { ...base, channel: "EMAIL" })

    expect(r).toEqual({ id: "cv-new", created: true })
    expect(tx.conversation.create.mock.calls[0][0].data).toEqual({
      tenantId: "t1",
      contactId: "ct1",
      channel: "EMAIL",
      status: "OPEN",
      subject: null,
      loanId: null,
      applicationId: null,
      lastInboundAt: null,
      lastActivityAt: now,
    })
  })

  it("stamps lastActivityAt with now on create, even when setLastInboundAt is unset", async () => {
    const tx = makeTx()
    tx.conversation.findFirst.mockResolvedValue(null)
    tx.conversation.create.mockResolvedValue({ id: "cv-new" })

    await resolveOpenThreadForContact(tx as any, base)

    expect(tx.conversation.create.mock.calls[0][0].data.lastActivityAt).toEqual(now)
  })

  it("stamps lastInboundAt on create when setLastInboundAt is set", async () => {
    const tx = makeTx()
    tx.conversation.findFirst.mockResolvedValue(null)
    tx.conversation.create.mockResolvedValue({ id: "cv-new" })

    await resolveOpenThreadForContact(tx as any, { ...base, setLastInboundAt: true })

    expect(tx.conversation.create.mock.calls[0][0].data.lastInboundAt).toEqual(now)
  })

  it("carries subject, loanId and applicationId onto the created thread", async () => {
    const tx = makeTx()
    tx.conversation.findFirst.mockResolvedValue(null)
    tx.conversation.create.mockResolvedValue({ id: "cv-new" })

    await resolveOpenThreadForContact(tx as any, {
      ...base,
      subject: "Loan application",
      loanId: "ln1",
      applicationId: "ap1",
    })

    const data = tx.conversation.create.mock.calls[0][0].data
    expect(data.subject).toBe("Loan application")
    expect(data.loanId).toBe("ln1")
    expect(data.applicationId).toBe("ap1")
  })

  describe("racing create", () => {
    const p2002 = () =>
      Object.assign(new Error("Unique constraint failed on the fields: (`Conversation_one_open_per_contact`)"), {
        code: "P2002",
        meta: { target: ["tenantId", "contactId"] },
      })

    it("adopts the winner's thread when the create loses the race", async () => {
      const tx = makeTx()
      tx.conversation.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: "cv-winner" })
      tx.conversation.create.mockRejectedValue(p2002())

      const r = await resolveOpenThreadForContact(tx as any, base)

      expect(r).toEqual({ id: "cv-winner", created: false })
      expect(tx.conversation.findFirst).toHaveBeenCalledTimes(2)
    })

    it("rethrows the original P2002 when the re-read finds nothing", async () => {
      const tx = makeTx()
      tx.conversation.findFirst.mockResolvedValue(null)
      tx.conversation.create.mockRejectedValue(p2002())

      await expect(resolveOpenThreadForContact(tx as any, base)).rejects.toThrow("Unique constraint failed")
    })

    it("rethrows the original P2002 when the transaction is already aborted", async () => {
      const tx = makeTx()
      tx.conversation.findFirst
        .mockResolvedValueOnce(null)
        .mockRejectedValueOnce(new Error("current transaction is aborted"))
      tx.conversation.create.mockRejectedValue(p2002())

      await expect(resolveOpenThreadForContact(tx as any, base)).rejects.toThrow("Unique constraint failed")
    })

    it("does NOT swallow a P2002 on a different constraint", async () => {
      const tx = makeTx()
      tx.conversation.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: "cv-winner" })
      tx.conversation.create.mockRejectedValue(
        Object.assign(new Error("Unique constraint failed"), { code: "P2002", meta: { target: ["someOtherIndex"] } }),
      )

      await expect(resolveOpenThreadForContact(tx as any, base)).rejects.toThrow("Unique constraint failed")
      expect(tx.conversation.findFirst).toHaveBeenCalledTimes(1)
    })
  })
})
