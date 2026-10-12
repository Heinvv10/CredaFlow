import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactElement } from "react"

const { requireMinRole, getResolvedTenantId, getDefaultTenantId, notFound, dsarFindMany, clientFindMany } = vi.hoisted(() => ({
  requireMinRole: vi.fn(),
  getResolvedTenantId: vi.fn(),
  getDefaultTenantId: vi.fn(),
  notFound: vi.fn(() => { throw new Error("NEXT_NOT_FOUND") }),
  dsarFindMany: vi.fn(),
  clientFindMany: vi.fn(),
}))

vi.mock("next/navigation", () => ({ notFound }))
vi.mock("@/lib/auth-guards", () => ({ requireMinRole }))
// getDefaultTenantId answers the env tenant, which is not the one this request
// resolved to: a page that reads it lists the wrong tenant's rows.
vi.mock("@/lib/tenant", () => ({ getResolvedTenantId, getDefaultTenantId }))
vi.mock("@/lib/prisma", () => ({
  prisma: { dataSubjectRequest: { findMany: dsarFindMany }, client: { findMany: clientFindMany } },
}))
vi.mock("@/components/nav/Breadcrumbs", () => ({ Breadcrumbs: () => null }))
vi.mock("@/components/compliance/DsarClient", () => ({ DsarClient: () => null }))

import Page from "./page"
import { DsarClient } from "@/components/compliance/DsarClient"

const ROWS = [{ id: "dsar-a" }]
const CLIENTS = [{ id: "client-a" }]

beforeEach(() => {
  vi.clearAllMocks()
  requireMinRole.mockResolvedValue({ id: "staff-a", tenantId: "tenant-a" })
  getResolvedTenantId.mockResolvedValue("tenant-a")
  getDefaultTenantId.mockResolvedValue("tenant-default")
  dsarFindMany.mockResolvedValue(ROWS)
  clientFindMany.mockResolvedValue(CLIENTS)
})

describe("/compliance/dsar", () => {
  it("requires ADMIN", async () => {
    await Page()
    expect(requireMinRole).toHaveBeenCalledWith("ADMIN")
  })

  it("lists only the tenant the request resolved to, for the requests and the client picker", async () => {
    const page = (await Page()) as ReactElement<{ children: ReactElement[] }>

    expect(dsarFindMany.mock.calls[0][0].where).toEqual({ tenantId: "tenant-a" })
    expect(clientFindMany.mock.calls[0][0].where).toEqual({ tenantId: "tenant-a" })
    const list = page.props.children.find((child) => child.type === DsarClient) as ReactElement<Record<string, unknown>>
    expect(list.props).toEqual({ dsars: ROWS, clients: CLIENTS })
  })

  it("is 404, reading nothing, when the host resolved to a tenant that is not the session's", async () => {
    getResolvedTenantId.mockResolvedValue("tenant-b")

    await expect(Page()).rejects.toThrow("NEXT_NOT_FOUND")
    expect(dsarFindMany).not.toHaveBeenCalled()
    expect(clientFindMany).not.toHaveBeenCalled()
  })
})
