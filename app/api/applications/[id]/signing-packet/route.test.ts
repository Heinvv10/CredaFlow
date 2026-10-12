import { createHash } from "node:crypto"
import { PDFDocument } from "pdf-lib"
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

/**
 * Who may read the signing packet, and what a read leaves behind.
 *
 * The client host's proxy admits this path for CLIENT sessions
 * (lib/proxy/shared-client-api.ts), so the route is the only thing between one
 * borrower and another borrower's PASQ and credit agreement.
 *
 * Only the session, prisma and storage are mocked. `requireOwnerOrStaff`,
 * `requireApiRole` and `withTenantContext` are the real ones: mocking a guard
 * would hide the very check under test. The prisma fake filters on whatever
 * `where` the route sends, so dropping a predicate changes what it returns.
 */

const {
  authMock,
  applicationFindUniqueMock,
  accessLogCreateMock,
  transactionMock,
  readFileMock,
  saveFileMock,
  deleteFileMock,
  rows,
} = vi.hoisted(() => ({
  authMock: vi.fn(),
  applicationFindUniqueMock: vi.fn(),
  accessLogCreateMock: vi.fn(),
  transactionMock: vi.fn(),
  readFileMock: vi.fn(),
  saveFileMock: vi.fn(),
  deleteFileMock: vi.fn(),
  rows: {
    tenants: [] as Record<string, unknown>[],
    applications: [] as Record<string, unknown>[],
    documents: [] as Record<string, unknown>[],
  },
}))

type Where = Record<string, unknown>

/** Prisma's equality filter, plus the one `{ not: null }` the route uses. */
function find(table: Record<string, unknown>[], where: Where) {
  return table.find((row) =>
    Object.entries(where).every(([key, value]) =>
      value !== null && typeof value === "object"
        ? row[key] !== null
        : row[key] === value,
    ),
  ) ?? null
}

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: {
      findFirst: async ({ where }: { where: Where }) => find(rows.tenants, where),
      findUnique: async ({ where }: { where: Where }) => find(rows.tenants, where),
    },
    loanApplication: {
      findUnique: (args: { where: Where }) => applicationFindUniqueMock(args),
    },
    clientDocument: {
      findFirst: async ({ where }: { where: Where }) => find(rows.documents, where),
    },
    documentAccessLog: { create: (args: unknown) => accessLogCreateMock(args) },
    $transaction: (arg: unknown) => transactionMock(arg),
  },
}))
vi.mock("@/lib/storage", () => ({
  readFile: (path: string) => readFileMock(path),
  saveFile: (...a: unknown[]) => saveFileMock(...a),
  deleteFile: (...a: unknown[]) => deleteFileMock(...a),
}))

import { GET, POST } from "./route"

const APPLICATION_ID = "app-1"
const LENDER = { id: "tenant-1", slug: "acme", name: "Acme Lending", domain: null, status: "ACTIVE" }
const OTHER_LENDER = { id: "tenant-2", slug: "other-lender", name: "Other Lender", domain: null, status: "ACTIVE" }

const owner = { user: { id: "client-1", email: "owner@portal.invalid", role: "CLIENT", tenantId: LENDER.id } }
const neighbour = { user: { id: "client-2", email: "neighbour@portal.invalid", role: "CLIENT", tenantId: LENDER.id } }
const outsider = { user: { id: "client-9", email: "outsider@portal.invalid", role: "CLIENT", tenantId: OTHER_LENDER.id } }
const officer = { user: { id: "user-1", email: "officer@acme-lending.invalid", role: "CREDIT_OFFICER", tenantId: LENDER.id } }
const outsideOfficer = { user: { id: "user-9", email: "officer@other-lender.invalid", role: "CREDIT_OFFICER", tenantId: OTHER_LENDER.id } }

async function pdfBytes(pages: number): Promise<Buffer> {
  const pdf = await PDFDocument.create()
  for (let i = 0; i < pages; i += 1) pdf.addPage([200, 200])
  return Buffer.from(await pdf.save())
}
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex")

let pasq: Buffer
let agreement: Buffer

const context = { params: Promise.resolve({ id: APPLICATION_ID }) }
const url = `http://portal.acme-lending.invalid/api/applications/${APPLICATION_ID}/signing-packet`

/** `host` is the lender whose deployment the request arrives at. */
function read(host = LENDER): Promise<Response> {
  const req = new NextRequest(url, {
    headers: {
      "x-tenant-slug": host.slug,
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "vitest",
    },
  })
  return GET(req, context) as Promise<Response>
}

function upload(): Promise<Response> {
  const form = new FormData()
  form.set("file", new File([new Uint8Array(pasq)], "signed.pdf", { type: "application/pdf" }))
  form.set("attestation", "true")
  const req = new NextRequest(url, {
    method: "POST",
    body: form,
    headers: { "x-tenant-slug": LENDER.slug },
  })
  return POST(req, context) as Promise<Response>
}

function expectNothingRead() {
  expect(readFileMock).not.toHaveBeenCalled()
  expect(accessLogCreateMock).not.toHaveBeenCalled()
}

beforeAll(async () => {
  pasq = await pdfBytes(2)
  agreement = await pdfBytes(3)
})

beforeEach(() => {
  vi.clearAllMocks()
  rows.tenants = [LENDER, OTHER_LENDER]
  rows.applications = [{
    id: APPLICATION_ID,
    tenantId: LENDER.id,
    clientId: owner.user.id,
    status: "APPROVED",
    agreementSignedAt: null,
    agreementGeneratedAt: new Date("2026-10-01T08:00:00.000Z"),
    pasqDocumentId: "pasq-doc",
    pasqDocumentSha256: sha(pasq),
    agreementDocumentId: "agreement-doc",
    agreementDocumentSha256: sha(agreement),
    signedPacketDocumentId: null,
    signedPacketDocumentSha256: null,
  }]
  rows.documents = [
    {
      id: "pasq-doc",
      tenantId: LENDER.id,
      clientId: owner.user.id,
      docType: "FORM_20_PRE_AGREEMENT",
      deletedAt: null,
      contentSha256: sha(pasq),
      storagePath: "/s/pasq.pdf",
    },
    {
      id: "agreement-doc",
      tenantId: LENDER.id,
      clientId: owner.user.id,
      docType: "CREDIT_AGREEMENT",
      deletedAt: null,
      contentSha256: sha(agreement),
      storagePath: "/s/agreement.pdf",
    },
  ]
  applicationFindUniqueMock.mockImplementation(
    async ({ where }: { where: Where }) => find(rows.applications, where),
  )
  accessLogCreateMock.mockImplementation(async ({ data }: { data: unknown }) => data)
  transactionMock.mockImplementation((ops: Promise<unknown>[]) => Promise.all(ops))
  readFileMock.mockImplementation(async (path: string) =>
    path === "/s/pasq.pdf" ? pasq : agreement,
  )
})

describe("GET signing packet — the borrower it belongs to", () => {
  beforeEach(() => authMock.mockResolvedValue(owner))

  it("returns the PASQ and the agreement as one PDF", async () => {
    const res = await read()
    expect(res.status).toBe(200)
    expect(res.headers.get("content-type")).toBe("application/pdf")
    expect(res.headers.get("x-pasq-sha256")).toBe(sha(pasq))
    expect(res.headers.get("x-agreement-sha256")).toBe(sha(agreement))
    const packet = await PDFDocument.load(await res.arrayBuffer())
    expect(packet.getPageCount()).toBe(5)
  })

  it("logs the read against both source documents, as the client", async () => {
    await read()
    const logged = accessLogCreateMock.mock.calls.map(([args]) => args.data)
    expect(logged).toEqual(["pasq-doc", "agreement-doc"].map((documentId) => ({
      documentId,
      accessorType: "client",
      accessorId: owner.user.id,
      action: "view_in_signing_packet",
      ipAddress: "203.0.113.7",
      userAgent: "vitest",
    })))
  })
})

describe("GET signing packet — everyone else", () => {
  it("refuses another client of the same lender", async () => {
    authMock.mockResolvedValue(neighbour)
    const res = await read()
    expect(res.status).toBe(403)
    expectNothingRead()
  })

  // On their own lender's host the tenant is theirs, so the application is
  // looked up in the wrong tenant and does not exist.
  it.each([
    ["client", outsider],
    ["staff member", outsideOfficer],
  ])("does not find the application for a %s of another lender", async (_who, session) => {
    authMock.mockResolvedValue(session)
    const res = await read(OTHER_LENDER)
    expect(res.status).toBe(404)
    expectNothingRead()
  })

  // On this lender's host their session belongs to a different tenant than the
  // request, and withTenantContext stops there.
  it.each([
    ["client", outsider],
    ["staff member", outsideOfficer],
  ])("refuses a %s of another lender before looking anything up", async (_who, session) => {
    authMock.mockResolvedValue(session)
    const res = await read()
    expect(res.status).toBe(403)
    expect(applicationFindUniqueMock).not.toHaveBeenCalled()
    expectNothingRead()
  })

  it("refuses a caller with no session", async () => {
    authMock.mockResolvedValue(null)
    const res = await read()
    expect(res.status).toBe(401)
    expectNothingRead()
  })

  it("still serves the lender's own staff, logged as staff", async () => {
    authMock.mockResolvedValue(officer)
    const res = await read()
    expect(res.status).toBe(200)
    expect(accessLogCreateMock.mock.calls.map(([args]) => args.data)).toEqual([
      expect.objectContaining({ documentId: "pasq-doc", accessorType: "staff", accessorId: officer.user.id }),
      expect.objectContaining({ documentId: "agreement-doc", accessorType: "staff", accessorId: officer.user.id }),
    ])
  })
})

// The proxy's allow-list matches the path, not the method: a CLIENT session
// reaches this handler too.
describe("POST returned packet — staff only", () => {
  function expectNothingWritten() {
    expect(applicationFindUniqueMock).not.toHaveBeenCalled()
    expect(saveFileMock).not.toHaveBeenCalled()
    expect(transactionMock).not.toHaveBeenCalled()
  }

  it("refuses the borrower the packet belongs to", async () => {
    authMock.mockResolvedValue(owner)
    const res = await upload()
    expect(res.status).toBe(403)
    expectNothingWritten()
  })

  it("refuses a caller with no session", async () => {
    authMock.mockResolvedValue(null)
    const res = await upload()
    expect(res.status).toBe(401)
    expectNothingWritten()
  })
})
