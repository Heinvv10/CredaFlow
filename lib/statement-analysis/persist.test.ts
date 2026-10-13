/** ensureStatementAnalysis / readStatementInBackground with Prisma, storage and the pipeline mocked. */
import { Prisma } from "@prisma/client"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { prisma } from "@/lib/prisma"
import { readFile } from "@/lib/storage"
import { analyseStatement } from "./analyse"
import { ensureStatementAnalysis, readStatementInBackground } from "./persist"
import { VlmUnavailableError } from "./vlm-reader"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: { findFirst: vi.fn() },
    statementAnalysis: { findFirst: vi.fn(), create: vi.fn(), deleteMany: vi.fn() },
    auditLog: { findFirst: vi.fn(), create: vi.fn() },
    $transaction: vi.fn(),
  },
}))
vi.mock("@/lib/storage", () => ({ readFile: vi.fn() }))
vi.mock("./analyse", () => ({ analyseStatement: vi.fn(), PARSER_VERSION: "statement-test-v9" }))

const docFind = vi.mocked(prisma.clientDocument.findFirst)
const saFind = vi.mocked(prisma.statementAnalysis.findFirst)
const saCreate = vi.mocked(prisma.statementAnalysis.create)
const auditFind = vi.mocked(prisma.auditLog.findFirst)
const readFileMock = vi.mocked(readFile)
const analyse = vi.mocked(analyseStatement)

const TENANT = "tenant-synth-1"
const DOC = "doc-synth-1"
const BYTES = Buffer.from("synthetic statement bytes")
const BYTES_SHA = sha256DocumentBytes(BYTES)

type Doc = { id: string; storagePath: string | null; mimeType: string | null; contentSha256: string | null }
const doc = (over: Partial<Doc> = {}): Doc => ({ id: DOC, storagePath: "synthetic/path.pdf", mimeType: "application/pdf", contentSha256: null, ...over })

const analysed = (over: Record<string, unknown> = {}) => ({
  method: "TEXT" as const,
  status: "READ" as const,
  bank: "CAPITEC" as const,
  read: {
    accountHolderName: "T TESTER", accountNumberLast4: "0001", periodStart: "2026-07-01", periodEnd: "2026-09-30",
    openingBalanceCents: 100, closingBalanceCents: 90,
    transactions: [{ date: "2026-07-02", description: "SYNTH", amountCents: -10, balanceCents: 90, page: 1 }],
  },
  balanceCheck: "PASS" as const,
  balanceDiffCents: 0,
  authenticity: { producer: "p", creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 0, signals: [] as string[] },
  ...over,
})

type CreateArg = { data: { status: string; contentSha256: string; parserVersion: string; tenantId: string; authenticity: { incrementalUpdates: number; signals: string[] } } }
const created = (): CreateArg["data"] => (saCreate.mock.calls[0][0] as unknown as CreateArg).data

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  docFind.mockResolvedValue(doc() as never)
  saFind.mockResolvedValue(null)
  saCreate.mockImplementation((async (args: { data: unknown }) => ({ id: "row-1", ...(args.data as object) })) as never)
  auditFind.mockResolvedValue(null)
  readFileMock.mockResolvedValue(BYTES)
  vi.mocked(prisma.$transaction).mockImplementation((async (cb: (tx: typeof prisma) => Promise<unknown>) => cb(prisma)) as never)
  analyse.mockResolvedValue(analysed())
})

afterEach(() => vi.restoreAllMocks())

const ensure = (allowVlm = true) => ensureStatementAnalysis({ tenantId: TENANT, documentId: DOC, allowVlm })

describe("ensureStatementAnalysis: document lookup", () => {
  it("returns missing for an absent or soft-deleted document, filtering on the tenant", async () => {
    docFind.mockResolvedValue(null)
    expect(await ensure()).toEqual({ state: "missing" })
    const where = docFind.mock.calls[0][0]!.where as Record<string, unknown>
    expect(where).toMatchObject({ id: DOC, tenantId: TENANT, docType: "BANK_STATEMENT", deletedAt: null })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("returns missing for a document with no stored file", async () => {
    docFind.mockResolvedValue(doc({ storagePath: null }) as never)
    expect(await ensure()).toEqual({ state: "missing" })
    expect(readFileMock).not.toHaveBeenCalled()
  })

  it("names the tenant in every query of a full read", async () => {
    auditFind.mockResolvedValue({ newValue: { originalIncrementalUpdates: 1 } } as never)
    await ensure()
    const wheres = [docFind, saFind, auditFind].flatMap((m) => m.mock.calls.map((c) => c[0]!.where as Record<string, unknown>))
    expect(wheres.length).toBe(3)
    for (const w of wheres) expect(w).toMatchObject({ tenantId: TENANT })
    expect(created().tenantId).toBe(TENANT)
  })
})

describe("ensureStatementAnalysis: caching", () => {
  it("returns a cached read for the row's contentSha256 without reading the file", async () => {
    const row = { id: "cached" }
    docFind.mockResolvedValue(doc({ contentSha256: "a".repeat(64) }) as never)
    saFind.mockResolvedValue(row as never)
    expect(await ensure()).toEqual({ state: "read", analysis: row })
    expect(readFileMock).not.toHaveBeenCalled()
    expect(analyse).not.toHaveBeenCalled()
    expect(saFind.mock.calls[0][0]!.where).toMatchObject({ tenantId: TENANT, clientDocumentId: DOC, contentSha256: "a".repeat(64), parserVersion: "statement-test-v9" })
  })

  it("hashes the bytes when the row has no sha, looks up by it and creates with it and the parser version", async () => {
    expect(await ensure()).toMatchObject({ state: "read" })
    expect(readFileMock).toHaveBeenCalledWith("synthetic/path.pdf")
    expect(saFind).toHaveBeenCalledTimes(1)
    expect(saFind.mock.calls[0][0]!.where).toMatchObject({ contentSha256: BYTES_SHA, parserVersion: "statement-test-v9" })
    expect(created()).toMatchObject({ contentSha256: BYTES_SHA, parserVersion: "statement-test-v9", status: "READ" })
  })

  it("binds the read to the bytes actually read when the row's claimed sha is stale", async () => {
    docFind.mockResolvedValue(doc({ contentSha256: "b".repeat(64) }) as never)
    await ensure()
    expect(saFind).toHaveBeenCalledTimes(2)
    expect(saFind.mock.calls[1][0]!.where).toMatchObject({ contentSha256: BYTES_SHA })
    expect(created().contentSha256).toBe(BYTES_SHA)
  })

  it("uses an existing read found by the hashed bytes without analysing again", async () => {
    const row = { id: "by-bytes" }
    saFind.mockResolvedValue(row as never)
    expect(await ensure()).toEqual({ state: "read", analysis: row })
    expect(analyse).not.toHaveBeenCalled()
    expect(saCreate).not.toHaveBeenCalled()
  })
})

describe("ensureStatementAnalysis: pending outcomes", () => {
  it("is pending file_missing, and creates nothing, when the file cannot be read", async () => {
    readFileMock.mockRejectedValue(new Error("ENOENT"))
    expect(await ensure()).toEqual({ state: "pending", reason: "file_missing" })
    expect(analyse).not.toHaveBeenCalled()
    expect(saCreate).not.toHaveBeenCalled()
  })

  it("is pending vlm_unavailable when the model is down and the caller allowed it", async () => {
    analyse.mockRejectedValue(new VlmUnavailableError("down"))
    expect(await ensure(true)).toEqual({ state: "pending", reason: "vlm_unavailable" })
    expect(saCreate).not.toHaveBeenCalled()
  })

  it("is pending vlm_deferred when the pipeline defers the vision read", async () => {
    analyse.mockRejectedValue(new VlmUnavailableError("vision read deferred"))
    expect(await ensure(false)).toEqual({ state: "pending", reason: "vlm_deferred" })
    expect(analyse).toHaveBeenCalledWith(BYTES, "application/pdf", { allowVlm: false })
    expect(saCreate).not.toHaveBeenCalled()
  })

  it("defers a non-PDF without calling the pipeline when the vision model is not allowed", async () => {
    docFind.mockResolvedValue(doc({ mimeType: "image/jpeg" }) as never)
    expect(await ensure(false)).toEqual({ state: "pending", reason: "vlm_deferred" })
    expect(analyse).not.toHaveBeenCalled()
    expect(saCreate).not.toHaveBeenCalled()
  })

  it("analyses a non-PDF when the vision model is allowed", async () => {
    docFind.mockResolvedValue(doc({ mimeType: "image/jpeg" }) as never)
    await ensure(true)
    expect(analyse).toHaveBeenCalledWith(BYTES, "image/jpeg", { allowVlm: true })
  })
})

describe("ensureStatementAnalysis: persisting", () => {
  it("persists an UNREADABLE row with READ_FAILED, instead of throwing, when the pipeline errors", async () => {
    analyse.mockRejectedValue(new Error("pdfinfo exploded"))
    const r = await ensure()
    expect(r.state).toBe("read")
    expect(created()).toMatchObject({ status: "UNREADABLE", contentSha256: BYTES_SHA })
    expect(created().authenticity.signals).toEqual(["READ_FAILED"])
  })

  it("lifts incrementalUpdates and signals DECRYPTED_AT_INTAKE from the intake audit row", async () => {
    auditFind.mockResolvedValue({ newValue: { originalIncrementalUpdates: 2 } } as never)
    await ensure()
    expect(created().authenticity.incrementalUpdates).toBe(2)
    expect(created().authenticity.signals).toContain("DECRYPTED_AT_INTAKE")
    expect(auditFind.mock.calls[0][0]!.where).toMatchObject({ entity: "ClientDocument", entityId: DOC, action: "DOCUMENT_DECRYPTED_AT_INTAKE" })
  })

  it("keeps the larger count when the file itself shows more revisions", async () => {
    analyse.mockResolvedValue(analysed({ authenticity: { producer: null, creator: null, createdAt: null, modifiedAt: null, incrementalUpdates: 5, signals: [] } }))
    auditFind.mockResolvedValue({ newValue: { originalIncrementalUpdates: 2 } } as never)
    await ensure()
    expect(created().authenticity.incrementalUpdates).toBe(5)
  })

  it("adds no decryption signal when there is no intake audit row", async () => {
    await ensure()
    expect(created().authenticity.incrementalUpdates).toBe(0)
    expect(created().authenticity.signals).not.toContain("DECRYPTED_AT_INTAKE")
  })

  it("returns the winner's row when a concurrent read takes the unique key (P2002)", async () => {
    const winner = { id: "winner" }
    saCreate.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("duplicate", { code: "P2002", clientVersion: "test" }))
    saFind.mockResolvedValueOnce(null).mockResolvedValueOnce(winner as never)
    expect(await ensure()).toEqual({ state: "read", analysis: winner })
    expect(saFind).toHaveBeenCalledTimes(2)
  })

  it("rethrows any other create failure", async () => {
    saCreate.mockRejectedValue(new Prisma.PrismaClientKnownRequestError("other", { code: "P2003", clientVersion: "test" }))
    await expect(ensure()).rejects.toThrow("other")
  })
})

describe("readStatementInBackground", () => {
  it("reads a document once while an earlier request for it is still in flight", async () => {
    let release: (v: null) => void = () => undefined
    docFind.mockReturnValueOnce(new Promise((res) => { release = res }) as never)

    readStatementInBackground(TENANT, "doc-bg-1")
    readStatementInBackground(TENANT, "doc-bg-1")
    await vi.waitFor(() => expect(docFind).toHaveBeenCalledTimes(1))
    release(null)
    await new Promise((r) => setTimeout(r, 20))
    expect(docFind).toHaveBeenCalledTimes(1)

    // Once finished the document can be queued again.
    docFind.mockResolvedValue(null)
    readStatementInBackground(TENANT, "doc-bg-1")
    await vi.waitFor(() => expect(docFind).toHaveBeenCalledTimes(2))
    expect(docFind.mock.calls[0][0]!.where).toMatchObject({ id: "doc-bg-1", tenantId: TENANT })
  })

  it("logs and survives a failed read", async () => {
    docFind.mockRejectedValue(Object.assign(new Error("db down"), { code: "X1" }))
    readStatementInBackground(TENANT, "doc-bg-2")
    await vi.waitFor(() => expect(console.error).toHaveBeenCalledTimes(1))
    expect(vi.mocked(console.error).mock.calls[0][1]).toMatchObject({ documentId: "doc-bg-2", code: "X1" })
  })
})

describe("ensureStatementAnalysis: round-2 behaviours", () => {
  const stored = (signals: string[], status = "UNREADABLE") => ({ id: "row-old", status, authenticity: { signals } })

  it("persistedOnly returns a stored read and otherwise pending, never reading the file", async () => {
    docFind.mockResolvedValue(doc({ contentSha256: BYTES_SHA }) as never)
    expect(await ensureStatementAnalysis({ tenantId: TENANT, documentId: DOC, allowVlm: false, persistedOnly: true }))
      .toEqual({ state: "pending", reason: "vlm_deferred" })
    saFind.mockResolvedValue(stored([], "READ") as never)
    expect(await ensureStatementAnalysis({ tenantId: TENANT, documentId: DOC, allowVlm: false, persistedOnly: true }))
      .toMatchObject({ state: "read" })
    expect(readFileMock).not.toHaveBeenCalled()
    expect(analyse).not.toHaveBeenCalled()
  })

  it("retryFailed discards a READ_FAILED read and reads again; anything else stays cached", async () => {
    docFind.mockResolvedValue(doc({ contentSha256: BYTES_SHA }) as never)
    saFind.mockResolvedValueOnce(stored(["READ_FAILED"]) as never)
    await ensureStatementAnalysis({ tenantId: TENANT, documentId: DOC, allowVlm: true, retryFailed: true, actorUserId: "officer-1" })
    expect(prisma.statementAnalysis.deleteMany).toHaveBeenCalledWith({ where: { id: "row-old", tenantId: TENANT } })
    // Discarding a stored read is audited, naming who asked.
    expect(prisma.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ tenantId: TENANT, userId: "officer-1", action: "STATEMENT_READ_RETRIED", entity: "StatementAnalysis", entityId: "row-old" }),
    })
    expect(analyse).toHaveBeenCalled()

    vi.mocked(analyse).mockClear()
    saFind.mockResolvedValue(stored(["TEXT_LAYER_ABSENT"]) as never)
    expect(await ensureStatementAnalysis({ tenantId: TENANT, documentId: DOC, allowVlm: true, retryFailed: true })).toMatchObject({ state: "read" })
    expect(analyse).not.toHaveBeenCalled()
  })

  it("does not store a failure caused by missing PDF tools: it says so and reads later", async () => {
    analyse.mockRejectedValue(Object.assign(new Error("spawn"), { code: 127 }))
    expect(await ensure()).toEqual({ state: "pending", reason: "reader_unavailable" })
    analyse.mockRejectedValue(Object.assign(new Error("spawn sh ENOENT"), { code: "ENOENT" }))
    expect(await ensure()).toEqual({ state: "pending", reason: "reader_unavailable" })
    expect(saCreate).not.toHaveBeenCalled()
  })

  it("runs onRead after a background read is stored", async () => {
    const onRead = vi.fn().mockResolvedValue(undefined)
    readStatementInBackground(TENANT, "doc-onread", { onRead })
    await vi.waitFor(() => expect(onRead).toHaveBeenCalledTimes(1))
  })

  it("carries a retry asked for while the document already waits onto that run", async () => {
    docFind.mockResolvedValue(doc({ id: "doc-retry", contentSha256: BYTES_SHA }) as never)
    saFind.mockResolvedValue({ id: "row-failed", status: "UNREADABLE", authenticity: { signals: ["READ_FAILED"] } } as never)
    // The first call queues a plain read; the second, while it waits, asks for a retry.
    readStatementInBackground(TENANT, "doc-retry")
    readStatementInBackground(TENANT, "doc-retry", { retryFailed: true, actorUserId: "officer-1" })
    await vi.waitFor(() => expect(prisma.statementAnalysis.deleteMany).toHaveBeenCalledWith({ where: { id: "row-failed", tenantId: TENANT } }))
  })

  it("runs a request made while the document is being read once that read is done", async () => {
    let release: () => void = () => undefined
    const gate = new Promise<void>((r) => { release = r })
    analyse.mockImplementationOnce((async () => { await gate; return analysed() }) as never)
    const late = vi.fn().mockResolvedValue(undefined)
    readStatementInBackground(TENANT, "doc-inflight")
    await vi.waitFor(() => expect(analyse).toHaveBeenCalledTimes(1))
    readStatementInBackground(TENANT, "doc-inflight", { onRead: late })
    release()
    await vi.waitFor(() => expect(late).toHaveBeenCalledTimes(1))
  })
})

