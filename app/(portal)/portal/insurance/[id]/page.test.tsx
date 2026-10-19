import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  getPortalTenantId: vi.fn(),
  clientFindFirst: vi.fn(),
  policyFindFirst: vi.fn(),
  loanFindFirst: vi.fn(),
  redirect: vi.fn(),
  notFound: vi.fn(),
  routerRefresh: vi.fn(),
}))

vi.mock("@/lib/auth", () => ({ auth: mocks.auth }))
vi.mock("@/lib/session-tenant", () => ({ getPortalTenantId: mocks.getPortalTenantId }))
const fsp = vi.hoisted(() => ({ number: "12345" as string | null }))
vi.mock("@/lib/config/identity", () => ({ getLenderIdentity: async () => ({ tradingName: "Acme Lending", fspNumber: fsp.number }) }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    client: { findFirst: mocks.clientFindFirst },
    insurancePolicy: { findFirst: mocks.policyFindFirst },
    loan: { findFirst: mocks.loanFindFirst },
  },
}))
vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
  notFound: mocks.notFound,
  // PprAcknowledgementCard is a client component that calls useRouter(); static
  // rendering supplies no router context.
  useRouter: () => ({ refresh: mocks.routerRefresh }),
}))

import PortalPolicyDetailPage from "./page"

function decimal(value: string) {
  return { toString: () => value, valueOf: () => Number(value) }
}

const POLICY = {
  id: "policy-1",
  policyNumber: "CL-0001",
  type: "CREDIT_LIFE",
  status: "ACTIVE",
  premiumAmount: decimal("85.50"),
  sumAssured: decimal("25000.00"),
  startDate: new Date("2026-03-01T00:00:00.000Z"),
  renewalDate: new Date("2027-03-01T00:00:00.000Z"),
  waitingPeriodEnds: null,
  linkedLoanId: null,
  policySource: "STANDALONE",
  insurer: null,
  insurer_rel: { name: "Clientele Life", fspNumber: "12345" },
  product: { name: "Credit Life Standard" },
  faisDisclosurePdfUrl: null,
  pprIssuedAt: null,
  pprAcknowledgedAt: null,
  beneficiaries: [],
}

const params = (id: string) => ({ params: Promise.resolve({ id }) })

describe("portal policy detail page", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.auth.mockResolvedValue({ user: { email: "client@example.test" } })
    mocks.redirect.mockImplementation((to: string) => {
      throw new Error(`NEXT_REDIRECT:${to}`)
    })
    // The real notFound() throws to halt rendering.
    mocks.notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND")
    })
    mocks.getPortalTenantId.mockResolvedValue("tenant-1")
    mocks.clientFindFirst.mockResolvedValue({ id: "client-1" })
    mocks.policyFindFirst.mockResolvedValue(POLICY)
    mocks.loanFindFirst.mockResolvedValue(null)
  })

  // The security case: the lookup must be constrained by the caller's own
  // clientId, so another client's policy id is a 404 and not a data leak.
  it("constrains the policy lookup to the caller's own clientId and tenant", async () => {
    await PortalPolicyDetailPage(params("policy-1"))

    expect(mocks.policyFindFirst).toHaveBeenCalledOnce()
    expect(mocks.policyFindFirst.mock.calls[0][0]).toMatchObject({
      where: { id: "policy-1", clientId: "client-1", tenantId: "tenant-1" },
    })
  })

  it("404s on another client's policy id instead of rendering it", async () => {
    // Scoped query finds nothing because the row belongs to a different client.
    mocks.policyFindFirst.mockResolvedValue(null)

    await expect(PortalPolicyDetailPage(params("someone-elses-policy"))).rejects.toThrow("NEXT_NOT_FOUND")

    expect(mocks.notFound).toHaveBeenCalled()
  })

  // §2a.2: the intermediary claim needs an FSP number.
  it("claims FAIS authorisation only when the lender holds an FSP number", async () => {
    expect(renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))).toContain("FAIS-authorised intermediary")
    fsp.number = null
    try {
      expect(renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))).not.toContain("FAIS-authorised")
    } finally {
      fsp.number = "12345"
    }
  })

  it("labels the FAIS claim as a fictional demo lender's on a demo stack", async () => {
    vi.stubEnv("DEMO_MODE", "true")
    try {
      expect(renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))).toContain(
        "FAIS-authorised intermediary. Demo lender: registration numbers are fictional.",
      )
    } finally {
      vi.unstubAllEnvs()
    }
    expect(renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))).not.toContain("Demo lender")
  })

  it("renders cover and premium in rands", async () => {
    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).toContain("R 85.50")
    expect(html).toContain("R 25,000.00")
    expect(html).not.toContain("R 0.86")
  })

  it("renders a beneficiary cover amount in rands", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      ...POLICY,
      beneficiaries: [
        {
          id: "ben-1",
          firstName: "Thandi",
          lastName: "Mokoena",
          relationship: "Spouse",
          coverAmount: decimal("12500.00"),
        },
      ],
    })

    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).toContain("Thandi")
    expect(html).toContain("R 12,500.00")
    expect(html).not.toContain("R 125.00")
  })

  it("offers the FAIS disclosure only when the client can actually open it", async () => {
    const without = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))
    expect(without).toContain("not available online")

    mocks.policyFindFirst.mockResolvedValue({
      ...POLICY,
      faisDisclosurePdfUrl: "/api/documents/doc-9/view",
    })
    const withDoc = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))
    expect(withDoc).toContain("/api/documents/doc-9/view")
    expect(withDoc).not.toContain("not available online")
  })

  it("offers no PPR acknowledgement before the disclosure has been issued", async () => {
    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).toContain("Product disclosure not yet issued")
    expect(html).not.toContain("Acknowledge disclosure")
  })

  // Acknowledging a disclosure the client was never shown would fabricate the
  // compliance record that feeds the FSCA return, so the action must be absent.
  it("refuses to offer acknowledgement when the disclosure document is not on file", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      ...POLICY,
      pprIssuedAt: new Date("2026-03-02T00:00:00.000Z"),
      faisDisclosurePdfUrl: null,
    })

    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).toContain("copy not available online")
    expect(html).not.toContain("Acknowledge disclosure")
  })

  // A standalone policy's url is /api/insurance/disclosures/<token>, which is
  // INSURANCE_OFFICER-gated with a 1h TTL. Offering "View" would hand the
  // client a guaranteed 403, and offering acknowledgement would invite an
  // attestation about a document they cannot open.
  it("neither links nor offers acknowledgement for a staff-only disclosure url", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      ...POLICY,
      pprIssuedAt: new Date("2026-03-02T00:00:00.000Z"),
      faisDisclosurePdfUrl: "/api/insurance/disclosures/draft-token-abc",
    })

    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).not.toContain("/api/insurance/disclosures/")
    expect(html).not.toContain("Acknowledge disclosure")
    expect(html).toContain("not available online")
  })

  // sumAssured is frozen at the original principal and renewalDate is the loan
  // maturity date, so for a bundled policy neither may be presented as current
  // cover or as a renewal.
  it("does not present a bundled policy's frozen sum assured as current cover, nor maturity as a renewal", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      ...POLICY,
      policySource: "BUNDLED_CREDIT_AGREEMENT",
    })

    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).toContain("Cover at inception")
    expect(html).toContain("Cover ends")
    expect(html).not.toContain("Renews")
    expect(html).toContain("follows the outstanding balance")
  })

  it("keeps plain cover and renewal wording for a non-bundled policy", async () => {
    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).toContain("Renews")
    expect(html).not.toContain("Cover at inception")
    expect(html).not.toContain("follows the outstanding balance")
  })

  it("does not assert an underwriting relationship when no insurer is recorded", async () => {
    mocks.policyFindFirst.mockResolvedValue({ ...POLICY, insurer_rel: null, insurer: null })

    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).not.toContain("Underwritten by")
    expect(html).toContain("Underwriter not yet recorded")
  })

  it("warns that a lapsed policy is not in force", async () => {
    mocks.policyFindFirst.mockResolvedValue({ ...POLICY, status: "LAPSED" })

    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).toContain("This policy is not in force")

    const active = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))
    expect(active).toBeDefined()
  })

  it("offers acknowledgement once the issued disclosure is retrievable", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      ...POLICY,
      pprIssuedAt: new Date("2026-03-02T00:00:00.000Z"),
      faisDisclosurePdfUrl: "/api/documents/doc-9/view",
    })

    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).toContain("Acknowledge disclosure")
    expect(html).toContain("/api/documents/doc-9/view")

    // The confirm checkbox must START disabled — it unlocks only once the
    // client actually opens the disclosure. Assert against the checkbox
    // element itself, NOT the whole document: the submit button's static
    // Tailwind classes contain the literal "disabled" (disabled:opacity-50),
    // so a document-wide toContain("disabled") passes even with the safeguard
    // deleted, and proves nothing.
    const checkbox = html.match(/<input[^>]*data-testid="ppr-confirm-checkbox"[^>]*>/)?.[0]
    expect(checkbox, "the PPR confirm checkbox should render").toBeDefined()
    expect(checkbox).toMatch(/\sdisabled(=|\s|\/?>)/)
  })

  it("reports an existing acknowledgement and drops the call to action", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      ...POLICY,
      pprIssuedAt: new Date("2026-03-02T00:00:00.000Z"),
      faisDisclosurePdfUrl: "/api/documents/doc-9/view",
      pprAcknowledgedAt: new Date("2026-03-05T00:00:00.000Z"),
    })

    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(html).toContain("Product disclosure acknowledged")
    expect(html).toContain("Recorded 05 Mar 2026")
    expect(html).not.toContain("Acknowledge disclosure")
  })

  it("only resolves a linked loan that also belongs to the caller", async () => {
    mocks.policyFindFirst.mockResolvedValue({
      ...POLICY,
      linkedLoanId: "loan-1",
      policySource: "BUNDLED_CREDIT_AGREEMENT",
    })
    mocks.loanFindFirst.mockResolvedValue({ id: "loan-1", reference: "L-0001" })

    const html = renderToStaticMarkup(await PortalPolicyDetailPage(params("policy-1")))

    expect(mocks.loanFindFirst.mock.calls[0][0]).toMatchObject({
      where: { id: "loan-1", clientId: "client-1", tenantId: "tenant-1" },
    })
    expect(html).toContain("L-0001")
    expect(html).toContain("attached to your credit agreement")
  })

  it("does not query for a loan when the policy is not loan-linked", async () => {
    await PortalPolicyDetailPage(params("policy-1"))

    expect(mocks.loanFindFirst).not.toHaveBeenCalled()
  })
})
