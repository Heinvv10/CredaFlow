// pinnedIssuance returns the introducer the issued document carried, from the
// input retained when it was issued, never the dealer as it is now. Pure unit
// test: the database and the file store are stubs (the real-Postgres proof is
// commission-pinned-issuance.integration.test.ts).
import { beforeEach, describe, expect, it, vi } from "vitest"
import { sha256DocumentBytes } from "@/lib/documents/content-integrity"

const m = vi.hoisted(() => ({ files: new Map<string, Buffer>() }))
vi.mock("@/lib/prisma", () => ({ prisma: {} }))
vi.mock("@/lib/storage", () => ({ readFile: vi.fn(async (path: string) => m.files.get(path)), saveFile: vi.fn() }))

import { DealDocumentError } from "../deal-document-error"
import { canonicalContent, contentSha256, starterContent } from "./content"
import { parseTemplateKey } from "./families"
import { pinnedIssuance, serializeRenderInput, type RenderInput } from "./issuance"
import { syntheticDealDocumentData } from "../synthetic-deal"

const content = canonicalContent(starterContent(parseTemplateKey("af.isa.commercial")!))
const base = syntheticDealDocumentData()

function store(input: RenderInput | Buffer, over: Partial<{ inputStoragePath: string | null }> = {}) {
  const bytes = Buffer.isBuffer(input) ? input : serializeRenderInput(input)
  m.files.set("input.json", bytes)
  const issuance = {
    id: "i1", tenantId: "t1", templateKey: "af.isa.commercial", templateId: "tpl", templateVersionId: "v1", templateContentSha256: contentSha256(content),
    approvalBasis: "SYNTHETIC_DEMO", lenderIdentity: base.lender, inputStoragePath: "input.json", inputSha256: sha256DocumentBytes(bytes), ...over,
  }
  return {
    assetDocumentIssuance: { findFirst: vi.fn(async () => issuance) },
    documentTemplateVersion: { findFirst: vi.fn(async () => ({ content })) },
  } as unknown as Parameters<typeof pinnedIssuance>[0]
}
const deal = (dealer?: { name: string; kind: "DEALER" | "BROKER" } | null): RenderInput => ({
  kind: "deal", document: "AGREEMENT", clientId: "c1", data: dealer === undefined ? base : { ...base, dealer },
})

describe("pinnedIssuance: the introducer comes from the retained input", () => {
  beforeEach(() => m.files.clear())

  it("returns the dealer the document was issued with", async () => {
    const pinned = await pinnedIssuance(store(deal({ name: "Original Dealer Motors", kind: "BROKER" })), "t1", "i1")
    expect(pinned?.dealer).toEqual({ name: "Original Dealer Motors", kind: "BROKER" })
  })

  it("returns none for a deal issued without one (null)", async () => {
    expect((await pinnedIssuance(store(deal(null)), "t1", "i1"))?.dealer).toBeNull()
  })

  it("returns none for an input retained before the disclosure existed (no dealer key at all)", async () => {
    const legacy = JSON.parse(serializeRenderInput(deal()).toString("utf8")) as { data: Record<string, unknown> }
    expect(legacy.data).not.toHaveProperty("dealer")
    expect((await pinnedIssuance(store(Buffer.from(JSON.stringify(legacy), "utf8")), "t1", "i1"))?.dealer).toBeNull()
  })

  it("returns none for an NCA input (never re-rendered at signing)", async () => {
    const nca = { kind: "nca", document: "AGREEMENT", clientId: "c1", data: { ...base, dealer: { name: "X", kind: "DEALER" } } } as unknown as RenderInput
    expect((await pinnedIssuance(store(nca), "t1", "i1"))?.dealer).toBeNull()
  })

  it("refuses when the retained input is gone or altered", async () => {
    await expect(pinnedIssuance(store(deal(null), { inputStoragePath: null }), "t1", "i1")).rejects.toThrow(DealDocumentError)
    const db = store(deal(null))
    m.files.set("input.json", Buffer.from("{}"))
    await expect(pinnedIssuance(db, "t1", "i1")).rejects.toThrow(/integrity/)
  })

  it("returns null for a row with no issuance", async () => {
    expect(await pinnedIssuance(store(deal(null)), "t1", null)).toBeNull()
  })
})
