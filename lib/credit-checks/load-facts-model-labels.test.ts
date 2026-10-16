/** loadApplicationFacts queues the model labels of a read that lacks them, in the background only. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const ensure = vi.fn()
const queueRead = vi.fn()
const recomputeClient = vi.fn()

vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: {
      findFirst: async () => ({
        id: "app-1", status: "UNDER_REVIEW", clientId: "client-1", submittedAt: null, createdAt: new Date("2026-10-05T08:00:00Z"),
        client: { firstName: "Thabo", lastName: "Tester", idNumber: "9001015000080", monthlyIncome: 1_800_000, popiaConsentGiven: true, debtObligations: [] },
      }),
      findMany: async () => [],
    },
    clientDocument: {
      findMany: async ({ where }: { where: { docType?: string; deletedAt?: unknown } }) =>
        where.docType === "BANK_STATEMENT" && where.deletedAt === null ? [{ id: "doc-1", uploadedByType: "staff", statementAnalyses: [] }] : [],
    },
    creditBureauCheck: { findFirst: async () => null },
  },
}))
vi.mock("@/lib/statement-analysis/persist", () => ({
  ensureStatementAnalysis: (a: unknown) => ensure(a),
  readStatementInBackground: (...a: unknown[]) => queueRead(...a),
}))
vi.mock("./recompute", () => ({ recomputeClientApplications: (...a: unknown[]) => recomputeClient(...a) }))

import { resetModelLabelBackoff, MODEL_LABELS } from "@/lib/statement-analysis/model-labels"
import { loadApplicationFacts, statementSnapshot } from "./load-facts"

const analysis = (over: Record<string, unknown> = {}) => ({
  id: "sa-1", status: "READ", method: "TEXT", bank: "CAPITEC", contentSha256: "sha-1", accountHolderName: "T TESTER", accountNumberLast4: "0001",
  periodStart: null, periodEnd: null, openingBalanceCents: null, closingBalanceCents: null, transactions: [], balanceCheck: "PASS",
  authenticity: { signals: [] }, modelCategories: null, modelCategoriesVersion: null, ...over,
})

beforeEach(() => {
  vi.resetAllMocks()
  vi.stubEnv("VLM_API_URL", "http://vlm.test")
  vi.stubEnv("VLM_MODEL", "synthetic-model")
  ensure.mockResolvedValue({ state: "read", analysis: analysis() })
  resetModelLabelBackoff()
    MODEL_LABELS.enabled = true
})
afterEach(() => vi.unstubAllEnvs())

describe("loadApplicationFacts: model labels", () => {
  it("queues an unlabelled read for labelling, and recomputes the client's checks once it is labelled", async () => {
    const { facts } = (await loadApplicationFacts("t1", "app-1"))!
    expect(facts.statements[0].modelLabels).toBeNull()
    expect(queueRead).toHaveBeenCalledWith("t1", "doc-1", { onLabelled: expect.any(Function) })
    await queueRead.mock.calls[0][2].onLabelled()
    expect(recomputeClient).toHaveBeenCalledWith("t1", "client-1")
  })

  it("passes stored labels through to the facts and queues nothing when they are current", async () => {
    ensure.mockResolvedValue({ state: "read", analysis: analysis({ modelCategories: { "SYNTH ZOLA": "FOOD" }, modelCategoriesVersion: "synthetic-model|labels-p3x3" }) })
    const { facts } = (await loadApplicationFacts("t1", "app-1"))!
    expect(facts.statements[0].modelLabels).toEqual({ "SYNTH ZOLA": "FOOD" })
    expect(queueRead).not.toHaveBeenCalled()
  })

  it("ignores stored labels from another prompt version", async () => {
    ensure.mockResolvedValue({ state: "read", analysis: analysis({ modelCategories: { "SYNTH ZOLA": "FOOD" }, modelCategoriesVersion: "synthetic-model|labels-p1" }) })
    const { facts } = (await loadApplicationFacts("t1", "app-1", { persistedOnly: true }))!
    expect(facts.statements[0].modelLabels).toBeNull()
  })

  it("ignores stored labels from another model, even with the current prompt", async () => {
    ensure.mockResolvedValue({ state: "read", analysis: analysis({ modelCategories: { "SYNTH ZOLA": "FOOD" }, modelCategoriesVersion: "older-model|labels-p3x3" }) })
    const { facts } = (await loadApplicationFacts("t1", "app-1", { persistedOnly: true }))!
    expect(facts.statements[0].modelLabels).toBeNull()
  })

  it("queues nothing for a persisted-only load (the panel, the approval)", async () => {
    await loadApplicationFacts("t1", "app-1", { persistedOnly: true })
    expect(queueRead).not.toHaveBeenCalled()
  })

  it("queues nothing when no model is configured", async () => {
    vi.stubEnv("VLM_MODEL", "")
    await loadApplicationFacts("t1", "app-1")
    expect(queueRead).not.toHaveBeenCalled()
  })
})

describe("statementSnapshot: model labels", () => {
  const db = (modelCategoriesAt: Date | null) => ({
    clientDocument: { findMany: async () => [{ id: "doc-1", statementAnalyses: [{ id: "sa-1", modelCategoriesAt }] }] },
  }) as unknown as Parameters<typeof statementSnapshot>[0]
  const where = { tenantId: "t1", clientId: "client-1", since: new Date(0) }

  it("keys a labelled read by when it was labelled, so labels stored after a recompute make the approval stale", async () => {
    expect(await statementSnapshot(db(null), where)).toEqual(["doc-1:sa-1"])
    expect(await statementSnapshot(db(new Date("2026-10-15T18:00:00Z")), where)).toEqual(["doc-1:sa-1:2026-10-15T18:00:00.000Z"])
  })
})
