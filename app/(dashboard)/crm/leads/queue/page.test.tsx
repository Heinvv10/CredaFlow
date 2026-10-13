import { beforeEach, describe, expect, it, vi } from "vitest"
import { renderToStaticMarkup } from "react-dom/server"

const mocks = vi.hoisted(() => ({
  leadFindMany: vi.fn(),
  getStaffTenantId: vi.fn(),
}))

vi.mock("@/lib/prisma", () => ({ prisma: { lead: { findMany: mocks.leadFindMany } } }))
vi.mock("@/lib/session-tenant", () => ({ getStaffTenantId: mocks.getStaffTenantId }))
vi.mock("@/components/nav/Breadcrumbs", () => ({ Breadcrumbs: () => null }))

import LeadQueuePage from "./page"

function lead(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "lead-1",
    firstName: "Thandi",
    lastName: "Mokoena",
    phone: "0712345678",
    source: "WEBSITE",
    status: "NEW",
    createdAt: new Date("2026-07-01T00:00:00.000Z"),
    updatedAt: new Date("2026-07-01T00:00:00.000Z"),
    tags: [],
    _count: { activities: 0 },
    ...over,
  }
}

const params = (filter?: string) => ({ searchParams: Promise.resolve(filter ? { filter } : {}) })

describe("CRM lead work queue", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getStaffTenantId.mockResolvedValue("tenant-1")
    mocks.leadFindMany.mockResolvedValue([lead()])
  })

  it("scopes the query to the tenant and to open statuses only", async () => {
    await LeadQueuePage(params())

    const where = mocks.leadFindMany.mock.calls[0][0].where
    expect(where.tenantId).toBe("tenant-1")
    expect(where.status.in).toEqual(["NEW", "CONTACTED", "QUALIFIED", "PROPOSAL_SENT"])
  })

  it("does not filter by tag unless the insurance filter is requested", async () => {
    await LeadQueuePage(params())

    expect(mocks.leadFindMany.mock.calls[0][0].where.tags).toBeUndefined()
  })

  // `has` is an exact array-element match. A `contains`-style test would also
  // match "insurance-enquiry-draft" and pull unrelated leads into the queue.
  it("filters on an exact tag match when the insurance filter is requested", async () => {
    await LeadQueuePage(params("insurance"))

    expect(mocks.leadFindMany.mock.calls[0][0].where.tags).toEqual({ has: "insurance-enquiry" })
  })

  it("ignores an unrecognised filter value rather than returning nothing", async () => {
    await LeadQueuePage(params("../../etc/passwd"))

    expect(mocks.leadFindMany.mock.calls[0][0].where.tags).toBeUndefined()
  })

  // Scoped to the badge element, NOT the whole document: the page always
  // renders an "Insurance only" filter button, so a document-wide
  // toContain("Insurance") passes whether or not the badge exists.
  const badge = (html: string) =>
    html.match(/<span[^>]*data-testid="insurance-enquiry-badge"[^>]*>(.*?)<\/span>/)?.[1] ?? null

  // Without this an adviser cannot tell an insurance enquiry from a loan lead
  // and answers the call with the wrong script.
  it("marks an insurance enquiry and names the cover interest", async () => {
    mocks.leadFindMany.mockResolvedValue([
      lead({ tags: ["insurance-enquiry", "cover:motor"] }),
    ])

    const html = renderToStaticMarkup(await LeadQueuePage(params()))

    expect(badge(html)).toContain("Insurance")
    expect(badge(html)).toContain("Vehicle")
  })

  it("does not mark an ordinary lead as an insurance enquiry", async () => {
    const html = renderToStaticMarkup(await LeadQueuePage(params()))

    expect(badge(html)).toBeNull()
  })

  it("omits the cover suffix when no cover tag is present", async () => {
    mocks.leadFindMany.mockResolvedValue([lead({ tags: ["insurance-enquiry"] })])

    const html = renderToStaticMarkup(await LeadQueuePage(params()))

    expect(badge(html)).toContain("Insurance")
    expect(badge(html)).not.toContain("·")
  })

  it("counts insurance enquiries within the unfiltered queue", async () => {
    mocks.leadFindMany.mockResolvedValue([
      lead({ id: "a", tags: ["insurance-enquiry"] }),
      lead({ id: "b", tags: [] }),
      lead({ id: "c", tags: ["insurance-enquiry", "cover:home"] }),
    ])

    const html = renderToStaticMarkup(await LeadQueuePage(params()))

    expect(html).toContain("Insurance only (2)")
  })

  it("offers a way back to the full queue while filtered", async () => {
    mocks.leadFindMany.mockResolvedValue([lead({ tags: ["insurance-enquiry"] })])

    const html = renderToStaticMarkup(await LeadQueuePage(params("insurance")))

    expect(html).toContain("Show all leads")
    expect(html).toContain("Insurance enquiries")
  })

  it("shows a filter-specific empty state so it does not read as no leads at all", async () => {
    mocks.leadFindMany.mockResolvedValue([])

    const html = renderToStaticMarkup(await LeadQueuePage(params("insurance")))

    expect(html).toContain("No open insurance enquiries")
  })
})
