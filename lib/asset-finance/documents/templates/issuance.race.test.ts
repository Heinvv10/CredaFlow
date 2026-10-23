// selectIssuableTemplate reads the template, then its current version. A
// publication committing between the two reads archives the version it was
// pointed at; that race must be refused as a publication during preparation,
// not as an unapproved version (templates-issuance IT, "a publication racing
// a preparation").
import { describe, expect, it, vi } from "vitest"
import { selectIssuableTemplate, TemplateNotIssuableError } from "./issuance"

vi.mock("@/lib/prisma", () => ({ prisma: {} }))

function fakeDb(currentVersionIds: Array<string | null>, version: Record<string, unknown> | null) {
  const reads = [...currentVersionIds]
  return {
    documentTemplate: { findFirst: vi.fn(async () => ({ id: "tpl1", currentVersionId: reads.shift() ?? null })) },
    documentTemplateVersion: { findFirst: vi.fn(async () => version) },
    tenantConfig: { findUnique: vi.fn(async () => null) },
  }
}

const archived = { id: "v1", templateId: "tpl1", status: "ARCHIVED", approvedById: "u1", approvedAt: new Date(), approvalBasis: "SYNTHETIC_DEMO", contentSha256: "x", approvedContentSha256: "x", content: {} }

describe("selectIssuableTemplate under a concurrent publication", () => {
  it("refuses as published-while-preparing when the current version moved between the reads", async () => {
    const refusal = await selectIssuableTemplate(fakeDb(["v1", "v2"], archived) as never, "t1", "af.isa.commercial").catch((e: unknown) => e)
    expect(refusal).toBeInstanceOf(TemplateNotIssuableError)
    expect((refusal as Error).message).toMatch(/published while the documents were being prepared/)
  })

  it("still refuses an unapproved current version as not approved when nothing moved", async () => {
    await expect(selectIssuableTemplate(fakeDb(["v1", "v1"], archived) as never, "t1", "af.isa.commercial"))
      .rejects.toThrow(/not approved for this exact wording/)
  })

  it("still refuses a missing version as not approved when nothing moved", async () => {
    await expect(selectIssuableTemplate(fakeDb(["v1", "v1"], null) as never, "t1", "af.isa.commercial"))
      .rejects.toThrow(/not approved for this exact wording/)
  })
})
