import { describe, expect, it, vi } from "vitest"
import { indicativeKeyFactsShown } from "./pre-submission"

const SHA = "b".repeat(64)
const terms = { indicativeKeyFacts: { productId: "p1", amountCents: 150_000, termDays: 30 } }

function db(document: object | null, template: object | null = { id: "tpl", currentVersionId: "v2" }) {
  const findFirst = vi.fn(async (_: unknown) => document)
  return { findFirst, tx: { clientDocument: { findFirst }, documentTemplate: { findFirst: async () => template } } as never }
}
const ask = (over: object = {}) => ({ tenantId: "t1", clientId: "c1", sha256: SHA, productId: "p1", amountCents: 150_000, termDays: 30, ...over })

describe("indicativeKeyFactsShown", () => {
  it("answers the document for exactly the terms shown", async () => {
    const { tx, findFirst } = db({ id: "doc", extractionResult: terms })
    expect(await indicativeKeyFactsShown(tx, ask())).toBe("doc")
    expect(findFirst.mock.calls[0][0]).toMatchObject({
      where: { tenantId: "t1", clientId: "c1", contentSha256: SHA, deletedAt: null, issuedForApplicationId: null, templateId: "tpl", generatedFromVersionId: "v2" },
    })
  })

  it("does not reach back further than a day", async () => {
    const { tx, findFirst } = db({ id: "doc", extractionResult: terms })
    await indicativeKeyFactsShown(tx, ask())
    const since = (findFirst.mock.calls[0][0] as { where: { createdAt: { gte: Date } } }).where.createdAt.gte
    expect(Math.abs(Date.now() - since.getTime() - 86_400_000)).toBeLessThan(5_000)
  })

  it.each([["amount", { amountCents: 150_100 }], ["term", { termDays: 31 }], ["product", { productId: "p2" }]])("refuses a statement read for another %s", async (_name, over) => {
    expect(await indicativeKeyFactsShown(db({ id: "doc", extractionResult: terms }).tx, ask(over))).toBeNull()
  })

  it("refuses no digest, no document, a document that is not a statement, and an unpublished template", async () => {
    expect(await indicativeKeyFactsShown(db({ id: "doc", extractionResult: terms }).tx, ask({ sha256: undefined }))).toBeNull()
    expect(await indicativeKeyFactsShown(db(null).tx, ask())).toBeNull()
    expect(await indicativeKeyFactsShown(db({ id: "doc", extractionResult: null }).tx, ask())).toBeNull()
    expect(await indicativeKeyFactsShown(db({ id: "doc", extractionResult: terms }, { id: "tpl", currentVersionId: null }).tx, ask())).toBeNull()
  })
})
