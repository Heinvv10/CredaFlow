import { beforeEach, describe, expect, it, vi } from "vitest"

/**
 * Whose debit mandate the portal page renders. Same rule as the signing page
 * (agreement/[applicationId]/page.test.ts): the session's client id, within
 * the request's tenant, never its possibly stale email. This page prefills
 * the client's bank account, so a wrong match discloses it.
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
vi.mock("./PortalDebitMandateClient", () => ({ PortalDebitMandateClient: () => null }))
const signingOtpView = vi.hoisted(() => vi.fn(async () => ({ required: true, channels: ["EMAIL", "WHATSAPP"] })))
vi.mock("@/lib/signing-otp/view", () => ({ signingOtpView }))

import PortalDebitMandatePage from "./page"

const ALICE = "client-alice"
const BOB = "client-bob"

function application(id: string, clientId: string, email: string, firstName: string, account: string, tenantId = "tenant-1") {
  return {
    id,
    tenantId,
    clientId,
    reference: `APP-${id}`,
    status: "APPROVED",
    repaymentMethod: "DEBIT_ORDER",
    agreementSignedAt: new Date("2026-10-01T09:00:00.000Z"),
    debitMandatePreparedAt: null,
    debitMandateDraftSha256: null,
    debitMandateSignedAt: null,
    client: {
      id: clientId,
      email,
      firstName,
      lastName: "Synthetic",
      bankName: "Example Bank",
      bankBranchCode: "000000",
      bankAccountNumber: account,
      accountType: "SAVINGS",
    },
  }
}

const session = (id: string, email: string, tenantId = "tenant-1") => ({
  user: { id, email, role: "CLIENT", tenantId },
})

async function render(applicationId: string) {
  const element = await PortalDebitMandatePage({ params: Promise.resolve({ applicationId }) })
  return (element as { props: Record<string, unknown> }).props
}

beforeEach(() => {
  resolvedTenant.id = "tenant-1"
  applications.length = 0
  applications.push(
    application("app-alice", ALICE, "alice@portal.invalid", "Alice", "1111111111"),
    application("app-bob", BOB, "bob@portal.invalid", "Bob", "2222222222"),
  )
})

describe("portal debit mandate page — whose mandate it renders", () => {
  it("renders the signed-in client's own mandate", async () => {
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid"))
    const props = await render("app-alice")
    expect(props).toMatchObject({ applicationId: "app-alice", clientName: "Alice Synthetic" })
    expect(props.initialBankDetails).toMatchObject({ accountNumber: "1111111111" })
    expect(props.signingOtp).toEqual({ required: true, channels: ["EMAIL", "WHATSAPP"] })
    expect(signingOtpView).toHaveBeenCalledWith("tenant-1", expect.objectContaining({ firstName: "Alice" }), "portal")
  })

  it("does not render Bob's mandate to Alice after their emails are swapped", async () => {
    applications[0].client = { ...applications[0].client as object, email: "bob@portal.invalid" }
    applications[1].client = { ...applications[1].client as object, email: "alice@portal.invalid" }
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid"))
    await expect(render("app-bob")).rejects.toThrow("NOT_FOUND")
  })

  it("still renders Alice's own mandate after her email changed under her session", async () => {
    applications[0].client = { ...applications[0].client as object, email: "alice.new@portal.invalid" }
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid"))
    expect(await render("app-alice")).toMatchObject({ applicationId: "app-alice" })
  })

  it("does not render another client's mandate", async () => {
    authMock.mockResolvedValue(session(ALICE, "alice@portal.invalid"))
    await expect(render("app-bob")).rejects.toThrow("NOT_FOUND")
  })

  it("does not render an application held in another tenant", async () => {
    applications.push(application("app-elsewhere", ALICE, "alice@portal.invalid", "Alice", "1111111111", "tenant-2"))
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
