import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Staff deal-signing routes: the gate (lib/asset-finance/signing-route.ts) and
// the real permission map run; the session, the flag row and the signing
// operations are stubbed. The real-database proof is
// lib/asset-finance/deal-signing.integration.test.ts.
const m = vi.hoisted(() => ({
  flag: { on: true },
  requireApiRole: vi.fn(),
  auditRefusal: vi.fn(),
  prepare: vi.fn(),
  contract: vi.fn(),
  upload: vi.fn(),
  confirm: vi.fn(),
  panel: vi.fn(),
  signerFindFirst: vi.fn(),
  serve: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: vi.fn() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenantConfig: { findUnique: async () => ({ featureCrm: false, featureIms: false, featureAssetFinance: m.flag.on }) },
    dealSigner: { findFirst: m.signerFindFirst },
  },
}))
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) => fn({ id: "tenant-1", name: "T" }),
}))
vi.mock("@/lib/auth-guards", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth-guards")>()),
  requireApiRole: () => m.requireApiRole(),
}))
vi.mock("@/lib/audit-refusals", () => ({ auditRefusal: m.auditRefusal }))
vi.mock("@/lib/asset-finance/signing-prepare", () => ({ prepareDealDocuments: m.prepare }))
vi.mock("@/lib/asset-finance/signing-contract", () => ({ contractDeal: m.contract }))
vi.mock("@/lib/asset-finance/signing-wet-ink", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-finance/signing-wet-ink")>()),
  uploadWetInkScan: m.upload,
  confirmWetInkScan: m.confirm,
}))
vi.mock("@/lib/asset-finance/signing-view", () => ({ loadStaffSigningPanel: m.panel }))
vi.mock("@/lib/asset-finance/deal-detail", () => ({ loadDealDetail: async (_t: string, id: string) => ({ id }) }))
vi.mock("@/lib/asset-finance/entity-document-io", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/asset-finance/entity-document-io")>()),
  serveEntityDocument: m.serve,
}))

import { LenderIdentityError } from "@/lib/config/identity"
import { GET as panel, POST as prepare } from "./route"
import { POST as contract } from "../contract/route"
import { GET as document } from "../signers/[signerId]/document/route"
import { POST as wetInk } from "../signers/[signerId]/wet-ink/route"
import { POST as confirm } from "../signers/[signerId]/confirm/route"

const signIn = (role: string, id = "user-1") =>
  m.requireApiRole.mockResolvedValue({ user: { id, email: `${id}@lender.test`, role, tenantId: "tenant-1" } })
const req = (body?: BodyInit) => new NextRequest("http://localhost/api/asset-finance/deals/deal-1/signing", { method: body ? "POST" : "GET", body })
const scanForm = (docType: string) => {
  const form = new FormData()
  form.set("docType", docType)
  form.set("file", new File([new Uint8Array(Buffer.from("%PDF-1.4 synthetic scan"))], "scan.pdf", { type: "application/pdf" }))
  return form
}
const deal = { params: Promise.resolve({ id: "deal-1" }) }
const signer = { params: Promise.resolve({ id: "deal-1", signerId: "signer-1" }) }
const writes = {
  prepare: () => prepare(req("{}"), deal),
  contract: () => contract(req("{}"), deal),
  wetInk: () => wetInk(req(scanForm("SIGNED_SURETYSHIP")), signer),
  confirm: () => confirm(req("{}"), signer),
}
const effects = [m.prepare, m.contract, m.upload, m.confirm]

beforeEach(() => {
  vi.clearAllMocks()
  m.flag.on = true
  signIn("CREDIT_OFFICER")
  m.prepare.mockResolvedValue({ kind: "prepared", signers: 2 })
  m.contract.mockResolvedValue({ kind: "contracted" })
  m.upload.mockResolvedValue({ kind: "done", scanDocumentId: "doc-1" })
  m.confirm.mockResolvedValue({ kind: "done", scanDocumentId: "doc-1" })
  m.panel.mockResolvedValue({ signers: [] })
  m.signerFindFirst.mockResolvedValue({
    id: "signer-1", document: "AGREEMENT", documentSha256: "a".repeat(64), documentStoragePath: "/x.pdf",
    client: { firstName: "TEST", lastName: "Director" }, deal: { application: { reference: "AF-1" } },
  })
  m.serve.mockResolvedValue(new Response("pdf", { status: 200 }))
})

describe("staff deal-signing routes", () => {
  it.each(Object.keys(writes))("%s answers 404 when the tenant has not enabled asset finance", async (name) => {
    m.flag.on = false
    expect((await writes[name as keyof typeof writes]()).status).toBe(404)
    for (const effect of effects) expect(effect).not.toHaveBeenCalled()
  })

  it("reads (panel, document) answer 404 with the flag off", async () => {
    m.flag.on = false
    expect((await panel(req(), deal)).status).toBe(404)
    expect((await document(req(), signer)).status).toBe(404)
    expect(m.serve).not.toHaveBeenCalled()
  })

  it.each(Object.keys(writes))("%s refuses a READONLY user 403 and audits it", async (name) => {
    signIn("READONLY")
    expect((await writes[name as keyof typeof writes]()).status).toBe(403)
    for (const effect of effects) expect(effect).not.toHaveBeenCalled()
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({
      action: "ASSET_DEAL_SIGNING_REFUSED", reason: "insufficient_role", status: 403, entityId: "deal-1",
    }))
  })

  it("a READONLY user reads the panel and a document (the read is served through the logging helper)", async () => {
    signIn("READONLY")
    expect((await panel(req(), deal)).status).toBe(200)
    expect((await document(req(), signer)).status).toBe(200)
    expect(m.serve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "signer-1", contentSha256: "a".repeat(64) }), { type: "staff", id: "user-1" })
  })

  it.each(Object.keys(writes))("%s works for a CREDIT_OFFICER", async (name) => {
    expect((await writes[name as keyof typeof writes]()).status).toBeLessThan(300)
  })

  it("confirm by the uploader is 403 and audited as four_eyes", async () => {
    m.confirm.mockResolvedValue({ kind: "four_eyes" })
    expect((await writes.confirm()).status).toBe(403)
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ reason: "four_eyes", status: 403 }))
  })

  it("contract with signers outstanding is 409, lists them and is audited", async () => {
    const outstanding = [{ clientId: "c-2", document: "SURETYSHIP", state: "PENDING", name: "TEST Surety" }]
    m.contract.mockResolvedValue({ kind: "incomplete", outstanding })
    const res = await writes.contract()
    expect(res.status).toBe(409)
    expect((await res.json()).outstanding).toEqual(outstanding)
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ reason: "signers_outstanding", status: 409 }))
  })

  it("prepare once signing has started is 409 and audited; an unconfigured identity is 422", async () => {
    m.prepare.mockResolvedValue({ kind: "signing_started" })
    expect((await writes.prepare()).status).toBe(409)
    expect(m.auditRefusal).toHaveBeenCalledWith(expect.objectContaining({ reason: "signing_started" }))
    m.prepare.mockRejectedValue(new LenderIdentityError(["legalName"]))
    const res = await writes.prepare()
    expect(res.status).toBe(422)
    expect(await res.json()).toMatchObject({ fields: ["legalName"] })
  })

  it("wet ink accepts only a SIGNED_* scan type", async () => {
    expect((await wetInk(req(scanForm("AFS")), signer)).status).toBe(400)
    expect(m.upload).not.toHaveBeenCalled()
  })
})
