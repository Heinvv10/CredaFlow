/** Model labels in the background read queue, with Prisma, storage and the model (fetch) mocked. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"
import { prisma } from "@/lib/prisma"
import { readFile } from "@/lib/storage"
import { labelPrompt, resetModelLabelBackoff } from "./model-labels"
import { ensureStatementAnalysis, MAX_WAITING_PER_TENANT, readStatementInBackground } from "./persist"

vi.mock("@/lib/prisma", () => ({
  prisma: {
    clientDocument: { findFirst: vi.fn() },
    statementAnalysis: { findFirst: vi.fn(), create: vi.fn(), updateMany: vi.fn() },
    auditLog: { findFirst: vi.fn() },
  },
}))
vi.mock("@/lib/storage", () => ({ readFile: vi.fn() }))
vi.mock("./analyse", () => ({ analyseStatement: vi.fn(), PARSER_VERSION: "statement-test-v9" }))

const TENANT = "tenant-synth-1"
const BYTES = Buffer.from("synthetic statement bytes")
const SHA = sha256DocumentBytes(BYTES)
const fetchMock = vi.fn()
const update = vi.mocked(prisma.statementAnalysis.updateMany)

const tx = (description: string, amountCents: number, nonPosting?: boolean) =>
  ({ date: "2026-07-02", description, amountCents, balanceCents: null, page: 1, ...(nonPosting && { nonPosting }) })
const stored = (over: Record<string, unknown> = {}) => ({
  id: "row-1", tenantId: TENANT, clientDocumentId: "doc-1", status: "READ", accountHolderName: "THABO TESTER",
  transactions: [
    tx("Card Purchase: SYNTH ZOLA TRADING 4411", -10_000),
    tx("Card Purchase: SYNTH ZOLA TRADING 9921", -20_000),
    tx("Card Purchase: SHOPRITE", -5_000),
    tx("Payment Received: SYNTH NOVA", 50_000),
    tx("EDO Collection Attempt SYNTH KITE", -7_000, true),
    tx("Payment To: THABO TESTER", -3_000),
    tx("Payment To: J SOAP", -4_000),
    tx("Payment To: SIPHO SYNTHETIC", -2_000),
  ],
  modelCategories: null, modelCategoriesVersion: null,
  ...over,
})
const answer = (content: string) => new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 })

beforeEach(() => {
  vi.resetAllMocks()
  vi.spyOn(console, "warn").mockImplementation(() => undefined)
  vi.spyOn(console, "error").mockImplementation(() => undefined)
  vi.stubEnv("VLM_API_URL", "http://vlm.test")
  vi.stubEnv("VLM_MODEL", "synthetic-model")
  vi.stubGlobal("fetch", fetchMock)
  vi.mocked(prisma.clientDocument.findFirst).mockResolvedValue({ id: "doc-1", storagePath: "s/p.pdf", mimeType: "application/pdf", contentSha256: SHA, client: { firstName: "Sipho", lastName: "Synthetic" } } as never)
  vi.mocked(prisma.statementAnalysis.findFirst).mockResolvedValue(stored() as never)
  vi.mocked(readFile).mockResolvedValue(BYTES)
  update.mockResolvedValue({ count: 1 })
  resetModelLabelBackoff()
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe("readStatementInBackground: model labels", () => {
  it("asks only for the debits no rule categorises, stores the labels on the tenant's row, then runs the callbacks", async () => {
    fetchMock.mockResolvedValueOnce(answer('{"labels": {"1": "FOOD", "2": "UNCATEGORISED"}}'))
    const order: string[] = []
    update.mockImplementation((async () => { order.push("stored"); return { count: 1 } }) as never)
    const onRead = vi.fn(async () => { order.push("onRead") })
    const onLabelled = vi.fn(async () => { order.push("onLabelled") })
    readStatementInBackground(TENANT, "doc-1", { onRead, onLabelled })
    await vi.waitFor(() => expect(onLabelled).toHaveBeenCalledTimes(1))

    const sent = JSON.parse(fetchMock.mock.calls[0][1].body).messages[0].content
    // Masked keys, each once: no amount, no reference digits, no credit, no non-posting row, and no own
    // transfer by the holder's name (THABO TESTER) or the client's (Sipho Synthetic).
    expect(sent).toBe(labelPrompt(["SYNTH ZOLA TRADING", "J SOAP"]))
    expect(update).toHaveBeenCalledWith({
      where: { id: "row-1", tenantId: TENANT },
      data: { modelCategories: { "SYNTH ZOLA TRADING": "FOOD", "J SOAP": "UNCATEGORISED" }, modelCategoriesVersion: "synthetic-model|labels-p1", modelCategoriesAt: expect.any(Date) },
    })
    expect(order).toEqual(["stored", "onRead", "onLabelled"])
  })

  it("looks the client's name up on the tenant's own document", async () => {
    fetchMock.mockResolvedValueOnce(answer('{"labels": {}}'))
    const onLabelled = vi.fn().mockResolvedValue(undefined)
    readStatementInBackground(TENANT, "doc-1", { onLabelled })
    await vi.waitFor(() => expect(onLabelled).toHaveBeenCalledTimes(1))
    expect(vi.mocked(prisma.clientDocument.findFirst)).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "doc-1", tenantId: TENANT }, select: { client: { select: { firstName: true, lastName: true } } } }))
  })

  it("model down: stores nothing, still runs the read's callbacks on the rules alone, not onLabelled", async () => {
    fetchMock.mockRejectedValue(new TypeError("fetch failed"))
    const onRead = vi.fn().mockResolvedValue(undefined)
    const onLabelled = vi.fn().mockResolvedValue(undefined)
    readStatementInBackground(TENANT, "doc-1", { onRead, onLabelled })
    await vi.waitFor(() => expect(onRead).toHaveBeenCalledTimes(1))
    expect(update).not.toHaveBeenCalled()
    expect(onLabelled).not.toHaveBeenCalled()
  })

  it("a failed store does not skip the read's callbacks", async () => {
    fetchMock.mockResolvedValueOnce(answer('{"labels": {"1": "FOOD"}}'))
    update.mockRejectedValueOnce(new Error("db down"))
    const onRead = vi.fn().mockResolvedValue(undefined)
    readStatementInBackground(TENANT, "doc-1", { onRead })
    await vi.waitFor(() => expect(onRead).toHaveBeenCalledTimes(1))
  })

  it("does not ask again for a read labelled by this model and prompt", async () => {
    vi.mocked(prisma.statementAnalysis.findFirst).mockResolvedValue(stored({ modelCategories: {}, modelCategoriesVersion: "synthetic-model|labels-p1" }) as never)
    const onRead = vi.fn().mockResolvedValue(undefined)
    const onLabelled = vi.fn().mockResolvedValue(undefined)
    readStatementInBackground(TENANT, "doc-1", { onRead, onLabelled })
    await vi.waitFor(() => expect(onRead).toHaveBeenCalledTimes(1))
    expect(fetchMock).not.toHaveBeenCalled()
    expect(onLabelled).not.toHaveBeenCalled()
  })

  it("asks again when the labels came from another model", async () => {
    vi.mocked(prisma.statementAnalysis.findFirst).mockResolvedValue(stored({ modelCategories: {}, modelCategoriesVersion: "older-model|labels-p1" }) as never)
    fetchMock.mockResolvedValueOnce(answer('{"labels": {}}'))
    const onLabelled = vi.fn().mockResolvedValue(undefined)
    readStatementInBackground(TENANT, "doc-1", { onLabelled })
    await vi.waitFor(() => expect(onLabelled).toHaveBeenCalledTimes(1))
  })
})

describe("label-only requests and the tenant's queue", () => {
  it("never crowd out a read: labelling read statements has its own allowance", async () => {
    // A hung model holds the queue; staff views queue more label-only jobs than the cap.
    fetchMock.mockImplementation(() => new Promise(() => undefined))
    for (let i = 0; i <= MAX_WAITING_PER_TENANT; i++) readStatementInBackground(TENANT, `read-${i}`, { onLabelled: async () => undefined })
    vi.mocked(console.warn).mockClear()
    readStatementInBackground(TENANT, "fresh-upload", { onRead: async () => undefined })
    expect(console.warn).not.toHaveBeenCalledWith("[statement-analysis] read not queued: tenant queue full", { documentId: "fresh-upload" })
    // ...and label-only jobs are capped too.
    readStatementInBackground(TENANT, "one-more-view", { onLabelled: async () => undefined })
    expect(console.warn).toHaveBeenCalledWith("[statement-analysis] read not queued: tenant queue full", { documentId: "one-more-view" })
  })
})

describe("a staff request never calls the model", () => {
  it.each([
    ["the checks' read", { allowVlm: false }],
    ["a persisted-only read", { allowVlm: false, persistedOnly: true }],
    ["even a vision-allowed read outside the queue", { allowVlm: true }],
  ])("%s returns the unlabelled read without asking", async (_, opts) => {
    const r = await ensureStatementAnalysis({ tenantId: TENANT, documentId: "doc-1", ...opts })
    expect(r).toMatchObject({ state: "read", analysis: { id: "row-1" } })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })
})
