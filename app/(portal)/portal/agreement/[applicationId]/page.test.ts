import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Whose agreement the signing page renders.
 *
 * A CLIENT JWT is never revalidated against the Client row, so its email can
 * be out of date: staff may change a client's email while that client is
 * signed in. Matching the application's client by email would then hand the
 * session somebody else's agreement. The page must match on the session's
 * client id, within the request's tenant, and the session must belong to that
 * tenant.
 *
 * The prisma fake filters on whatever `where` the page sends, so dropping a
 * predicate changes what it returns.
 */

const { authMock, resolvedTenant, applications } = vi.hoisted(() => ({
  authMock: vi.fn(),
  resolvedTenant: { id: "tenant-1" },
  applications: [] as Record<string, unknown>[],
}))

type Where = Record<string, unknown>
const find = (where: Where) =>
  applications.find((row) => Object.entries(where).every(([k, v]) => row[k] === v)) ?? null

vi.mock("@/lib/auth", () => ({ auth: () => authMock() }))
vi.mock("@/lib/tenant", () => ({
  getResolvedTenantId: async () => resolvedTenant.id,
  getDefaultTenantId: async () => resolvedTenant.id,
}))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    loanApplication: {
      findFirst: async ({ where }: { where: Where }) => find(where),
      findUnique: async ({ where }: { where: Where }) => find(where),
    },
  },
}))
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT ${url}`)
  },
  notFound: () => {
    throw new Error("NOT_FOUND")
  },
}))
vi.mock("./PortalAgreementClient", () => ({ PortalAgreementClient: () => null }))
const signingOtpView = vi.hoisted(() => vi.fn(async () => ({ required: true, channels: ["EMAIL"] })))
vi.mock("@/lib/signing-otp/view", () => ({ signingOtpView }))

import PortalAgreementPage from "./page"

const ALICE = "client-alice"
const BOB = "client-bob"

function application(id: string, clientId: string, email: string, firstName: string, tenantId = "tenant-1") {
  return {
    id,
    tenantId,
    clientId,
    reference: `APP-${id}`,
    agreementGeneratedAt: new Date("2026-10-01T08:00:00.000Z"),
    agreementSignedAt: null,
    agreementDocumentSha256: "a".repeat(64),
    agreementExecutedDocumentId: null,
    pasqDocumentSha256: "b".repeat(64),
    repaymentMethod: "EFT",
    client: { email, firstName, lastName: "Synthetic" },
  }
}

const session = (id: string, email: string, tenantId = "tenant-1") => ({
  user: { id, email, role: "CLIENT", tenantId },
})

async function render(applicationId: string) {
  const element = await PortalAgreementPage({ params: Promise.resolve({ applicationId }) })
  return (element as { props: Record<string, unknown> }).props
}

beforeEach(() => {
  resolvedTenant.id = "tenant-1"
  applications.length = 0
  applications.push(
    application("app-alice", ALICE, "alice@portal.invalid", "Alice"),
    application("app-bob", BOB, "bob@portal.invalid", "Bob"),
  )
})

describe("portal signing page — whose agreement it renders", () => {
  it("renders the signed-in client's own agreement", async () => {
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid"))
    expect(await render("app-alice")).toMatchObject({ applicationId: "app-alice", clientName: "Alice Synthetic" })
  })

  it("asks the lender's policy whether portal signing needs a code, and passes the answer down", async () => {
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid"))
    expect(await render("app-alice")).toMatchObject({ signingOtp: { required: true, channels: ["EMAIL"] } })
    expect(signingOtpView).toHaveBeenCalledWith("tenant-1", expect.objectContaining({ firstName: "Alice" }), "portal")
  })

  // Staff swapped the two clients' emails while Alice was signed in: her JWT
  // still carries her old address, which is now Bob's.
  it("does not render Bob's agreement to Alice after their emails are swapped", async () => {
    applications[0].client = { ...applications[0].client as object, email: "bob@portal.invalid" }
    applications[1].client = { ...applications[1].client as object, email: "alice@portal.invalid" }
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid"))
    await expect(render("app-bob")).rejects.toThrow("NOT_FOUND")
  })

  it("still renders Alice's own agreement after her email changed under her session", async () => {
    applications[0].client = { ...applications[0].client as object, email: "alice.new@portal.invalid" }
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid"))
    expect(await render("app-alice")).toMatchObject({ applicationId: "app-alice" })
  })

  it("does not render another client's agreement", async () => {
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid"))
    await expect(render("app-bob")).rejects.toThrow("NOT_FOUND")
  })

  it("does not render an application held in another tenant", async () => {
    applications.push(application("app-elsewhere", ALICE, "alice@portal.invalid", "Alice", "tenant-2"))
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid"))
    await expect(render("app-elsewhere")).rejects.toThrow("NOT_FOUND")
  })

  it("renders nothing to a session bound to another tenant than the request's", async () => {
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid", "tenant-2"))
    await expect(render("app-alice")).rejects.toThrow("NOT_FOUND")
  })

  it("sends a visitor with no session to the portal login", async () => {
    authMock.mockResolvedValue(null)
    await expect(render("app-alice")).rejects.toThrow("REDIRECT /portal/login")
  })
})
