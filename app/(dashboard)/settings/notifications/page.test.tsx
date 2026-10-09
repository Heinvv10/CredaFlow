import { beforeEach, describe, expect, it, vi } from "vitest"

const {
  requireMinRole,
  hasMinRole,
  getResolvedTenantId,
  tenantFindFirst,
  templateFindMany,
  logFindMany,
} = vi.hoisted(() => ({
  requireMinRole: vi.fn(),
  hasMinRole: vi.fn(),
  getResolvedTenantId: vi.fn(),
  tenantFindFirst: vi.fn(),
  templateFindMany: vi.fn(),
  logFindMany: vi.fn(),
}))

vi.mock("@/lib/auth-guards", () => ({ requireMinRole, hasMinRole }))
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    tenant: { findFirst: tenantFindFirst },
    messageTemplate: { findMany: templateFindMany },
    notificationLog: { findMany: logFindMany },
  },
}))
vi.mock("@/components/layout/Header", () => ({ Header: () => null }))
vi.mock("./NotificationsSettingsClient", () => ({ NotificationsSettingsClient: () => null }))

import NotificationsSettingsPage from "./page"

function template(overrides: Record<string, unknown> = {}) {
  return {
    id: "tpl1",
    event: "loan_approved",
    channel: "WHATSAPP",
    subject: null,
    body: "b",
    active: true,
    wabaTemplateName: "loan_approved",
    language: "en",
    category: "SERVICE",
    headerContent: null,
    bodyTemplate: "b",
    footer: null,
    buttons: null,
    providerStatus: null,
    providerTemplateId: null,
    createdAt: new Date("2026-07-25T08:00:00Z"),
    updatedAt: new Date("2026-07-25T08:00:00Z"),
    ...overrides,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  requireMinRole.mockResolvedValue({ id: "u1", role: "ADMIN" })
  hasMinRole.mockReturnValue(true)
  getResolvedTenantId.mockResolvedValue("tenant-1")
  tenantFindFirst.mockResolvedValue({ id: "tenant-1", name: "Acme Lending" })
  templateFindMany.mockResolvedValue([])
  logFindMany.mockResolvedValue([])
})

describe("tenant resolution", () => {
  // Must match the WABA route, which resolves through withTenantContext. A bare
  // findFirst({status:"ACTIVE"}) picked an arbitrary tenant, so with a second
  // active tenant this page listed another tenant's template bodies and Meta
  // names — and saving one copied them into the caller's tenant.
  it("scopes to the resolved tenant, not to an arbitrary active one", async () => {
    await NotificationsSettingsPage()
    expect(getResolvedTenantId).toHaveBeenCalled()
    expect(tenantFindFirst).toHaveBeenCalledWith({
      where: { id: "tenant-1", status: "ACTIVE" },
    })
    expect(templateFindMany).toHaveBeenCalledWith({ where: { tenantId: "tenant-1" } })
  })

  // This filter has been removed once already by an unrelated refactor of the
  // line above it; without a test the next one would land silently.
  it("renders nothing for a tenant that is not ACTIVE", async () => {
    tenantFindFirst.mockResolvedValue(null)
    expect(await NotificationsSettingsPage()).toBeNull()
    expect(templateFindMany).not.toHaveBeenCalled()
  })
})

describe("WABA tab gating", () => {
  // The WABA route is ADMIN while this page is LOAN_ADMIN. An ungated tab hands
  // a LOAN_ADMIN a full editor that 403s on save.
  it("gates the editor on the same ADMIN hierarchy check the route uses", async () => {
    await NotificationsSettingsPage()
    expect(hasMinRole).toHaveBeenCalledWith("ADMIN", "ADMIN")
  })
})

describe("waba template projection", () => {
  it("passes only WHATSAPP templates, carrying the provider state the editor shows", async () => {
    templateFindMany.mockResolvedValue([
      template({ id: "wa1", channel: "WHATSAPP", providerStatus: "PENDING", providerTemplateId: "meta-1" }),
      template({ id: "sms1", channel: "SMS", event: "loan_approved" }),
    ])
    const element = await NotificationsSettingsPage()
    const client = JSON.stringify(
      (element as { props: { children: unknown[] } }).props.children,
    )
    const parsed = JSON.parse(client) as Array<{ props?: { wabaTemplates?: Array<{ id: string }> } }>
    const waba = parsed.find((c) => c?.props?.wabaTemplates)?.props?.wabaTemplates ?? []
    expect(waba.map((t) => t.id)).toEqual(["wa1"])
    expect(waba[0]).toMatchObject({ providerStatus: "PENDING", providerTemplateId: "meta-1" })
  })
})
