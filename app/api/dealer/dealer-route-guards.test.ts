import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

// Every guarded dealer portal route, through the real requireDealer/withDealer
// (lib/dealer/guards.ts): no session 401; a staff, client or operator session,
// another lender's dealer and the portal switched off 404; DEALER_SALES 404 on
// the admin routes; a write that does not say it is same-origin 403. The
// dealer-domain libraries behind the routes are stubbed: what is tested here is
// who reaches them.
const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
  config: { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true } as Record<string, boolean> | null,
  reached: [] as string[],
}))
const { reach } = vi.hoisted(() => ({
  reach: <T,>(name: string, value: T) => async () => {
    h.reached.push(name)
    return value
  },
}))

vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/prisma", () => ({ prisma: { tenantConfig: { findUnique: async () => h.config } } }))
vi.mock("@/lib/tenant", () => ({
  getTenantFromRequest: async () => ({ id: "tenant-1", slug: "lender", name: "Lender", domain: null, status: "ACTIVE" }),
  withTenantContext: async (_req: Request, fn: (t: { id: string }) => Promise<Response>) => fn({ id: "tenant-1" }),
}))
vi.mock("@/lib/dealer/deal-view", () => ({ listDealerDeals: reach("listDealerDeals", []), loadDealerDealView: reach("loadDealerDealView", { id: "deal-1" }) }))
vi.mock("@/lib/dealer/deals", () => ({
  createDealerDeal: reach("createDealerDeal", { kind: "created", dealId: "deal-1" }),
}))
vi.mock("@/lib/dealer/capture", () => ({
  captureDealerEntity: reach("captureDealerEntity", { kind: "created", id: "e-1" }),
  captureDealerPerson: reach("captureDealerPerson", { kind: "created", id: "c-1" }),
  captureDealerAsset: reach("captureDealerAsset", { kind: "created", id: "a-1" }),
}))
vi.mock("@/lib/dealer/captures", () => ({
  listDealerEntities: reach("listDealerEntities", []), listDealerPeople: reach("listDealerPeople", []), listDealerAssets: reach("listDealerAssets", []),
}))
vi.mock("@/lib/dealer/consent", () => ({ attestDealerConsent: reach("attestDealerConsent", { kind: "attested", attestationIds: ["att-1"] }) }))
vi.mock("@/lib/dealer/cancel", () => ({ cancelDealerDraft: reach("cancelDealerDraft", { kind: "cancelled" }) }))
vi.mock("@/lib/dealer/submit", () => ({ submitDealerDeal: reach("submitDealerDeal", { kind: "submitted", at: new Date("2026-10-19T10:00:00Z") }) }))
vi.mock("@/lib/dealer/documents", () => ({
  DEALER_UPLOAD_DOC_TYPES: ["POPIA_CONSENT"],
  listDealerDocuments: reach("listDealerDocuments", []),
  uploadDealerDocument: reach("uploadDealerDocument", { kind: "stored", document: { id: "doc-1", docType: "POPIA_CONSENT", fileName: "c.pdf", createdAt: "2026-10-19T10:00:00.000Z" } }),
  serveDealerDocument: reach("serveDealerDocument", new Response("bytes")),
}))
vi.mock("@/lib/asset-finance/entity-document-io", () => ({
  parseEntityDocumentForm: async () => ({ upload: { file: new File(["x"], "c.pdf"), docType: "POPIA_CONSENT", dealId: null } }),
}))
vi.mock("@/lib/dealer/users", () => ({
  parseDealerUserInput: () => ({ data: { email: "new@dealer.example", name: "New", role: "DEALER_SALES" } }),
  listDealerUsers: reach("listDealerUsers", []),
  createDealerUser: reach("createDealerUser", { kind: "created", userId: "du-2", token: "t".repeat(64), expiresAt: new Date("2026-10-22T10:00:00Z") }),
  deactivateDealerUser: reach("deactivateDealerUser", { kind: "deactivated" }),
}))
vi.mock("@/lib/dealer/password-links", () => ({ dealerPasswordUrl: (t: string) => `https://dealers.lender.example/dealer/set-password?token=${t}` }))
vi.mock("@/lib/config/deployment-urls", () => ({ requireDealerBaseUrl: () => "https://dealers.lender.example" }))
vi.mock("@/lib/dealer/preview", () => ({ previewDealerDeal: reach("previewDealerDeal", { status: 200, body: { startDate: "2026-11-01" } }) }))

import * as users from "./users/route"
import * as deactivate from "./users/[id]/deactivate/route"
import * as entities from "./borrowers/entities/route"
import * as people from "./borrowers/entities/[id]/people/route"
import * as clients from "./borrowers/clients/route"
import * as assets from "./assets/route"
import * as deals from "./deals/route"
import * as preview from "./deals/preview/route"
import * as deal from "./deals/[id]/route"
import * as documents from "./deals/[id]/documents/route"
import * as document from "./deals/[id]/documents/[docId]/route"
import * as consents from "./deals/[id]/consents/route"
import * as submit from "./deals/[id]/submit/route"
import * as cancel from "./deals/[id]/cancel/route"

type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>
const ROUTES: Array<[string, "GET" | "POST", Handler, { admin?: true }?]> = [
  ["users", "GET", users.GET as Handler, { admin: true }],
  ["users", "POST", users.POST as Handler, { admin: true }],
  ["users/[id]/deactivate", "POST", deactivate.POST as Handler, { admin: true }],
  ["borrowers/entities", "GET", entities.GET as Handler],
  ["borrowers/entities", "POST", entities.POST as Handler],
  ["borrowers/entities/[id]/people", "POST", people.POST as Handler],
  ["borrowers/clients", "GET", clients.GET as Handler],
  ["borrowers/clients", "POST", clients.POST as Handler],
  ["assets", "GET", assets.GET as Handler],
  ["assets", "POST", assets.POST as Handler],
  ["deals", "GET", deals.GET as Handler],
  ["deals", "POST", deals.POST as Handler],
  ["deals/preview", "POST", preview.POST as Handler],
  ["deals/[id]", "GET", deal.GET as Handler],
  ["deals/[id]/documents", "GET", documents.GET as Handler],
  ["deals/[id]/documents", "POST", documents.POST as Handler],
  ["deals/[id]/documents/[docId]", "GET", document.GET as Handler],
  ["deals/[id]/consents", "POST", consents.POST as Handler],
  ["deals/[id]/submit", "POST", submit.POST as Handler],
  ["deals/[id]/cancel", "POST", cancel.POST as Handler],
]

const DEALER = { id: "du-1", email: "admin@dealer.example", role: "DEALER", tenantId: "tenant-1", dealerId: "dealer-1", dealerRole: "DEALER_ADMIN" }
const ctx = { params: Promise.resolve({ id: "x-1", docId: "doc-1" }) }
function request(method: string, headers: Record<string, string> = { "sec-fetch-site": "same-origin" }) {
  const body = method === "POST" ? JSON.stringify({ attested: true, documentId: "doc-1", clientIds: ["c-1"], reason: "TEST the buyer walked away" }) : undefined
  return new NextRequest("https://dealers.lender.example/api/dealer/x", {
    method, body, headers: { host: "dealers.lender.example", "content-type": "application/json", ...headers },
  })
}
const call = (route: (typeof ROUTES)[number], headers?: Record<string, string>) => route[2](request(route[1], headers), ctx)

beforeEach(() => {
  h.session = { user: { ...DEALER } }
  h.config = { featureAssetFinance: true, featureDealerPortal: true, isDemoLender: true }
  h.reached = []
})

describe.each(ROUTES)("%s %s", (_path, method, handler, opts) => {
  const route = ROUTES.find((r) => r[2] === handler)!

  it("serves a DEALER_ADMIN of the host's lender", async () => {
    expect((await call(route)).status).toBeLessThan(300)
    expect(h.reached.length).toBe(1)
  })

  it("answers 401 with no session, reaching nothing", async () => {
    h.session = null
    expect((await call(route)).status).toBe(401)
    expect(h.reached).toEqual([])
  })

  it.each([
    ["a staff", { id: "u-1", email: "a@lender.test", role: "SUPER_ADMIN", tenantId: "tenant-1" }],
    ["a client", { id: "c-1", email: "c@client.test", role: "CLIENT", tenantId: "tenant-1" }],
    ["an operator", { id: "op-1", email: "o@op.test", role: "OPERATOR_ADMIN", tenantId: null, operatorId: "operator-1" }],
    ["another lender's dealer", { ...DEALER, tenantId: "tenant-2" }],
  ])("answers 404 to %s session, reaching nothing", async (_label, user) => {
    h.session = { user }
    expect((await call(route)).status).toBe(404)
    expect(h.reached).toEqual([])
  })

  it("answers 404 when the lender's portal is off", async () => {
    h.config = { featureAssetFinance: true, featureDealerPortal: false, isDemoLender: true }
    expect((await call(route)).status).toBe(404)
    expect(h.reached).toEqual([])
  })

  it(opts?.admin ? "answers 404 to DEALER_SALES" : "serves DEALER_SALES", async () => {
    h.session = { user: { ...DEALER, dealerRole: "DEALER_SALES" } }
    const res = await call(route)
    if (opts?.admin) {
      expect(res.status).toBe(404)
      expect(h.reached).toEqual([])
    } else {
      expect(res.status).toBeLessThan(300)
    }
  })

  if (method === "POST") {
    it.each([
      ["no Origin or Sec-Fetch-Site", {}],
      ["Sec-Fetch-Site same-site", { "sec-fetch-site": "same-site" }],
      ["a sibling lender's Origin", { origin: "https://other-lender.example" }],
    ])("refuses a write with %s (403), reaching nothing", async (_label, headers) => {
      expect((await call(route, headers)).status).toBe(403)
      expect(h.reached).toEqual([])
    })
  }
})
