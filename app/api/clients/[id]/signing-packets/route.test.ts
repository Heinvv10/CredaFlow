import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"

const caller = vi.hoisted(() => ({ value: null as unknown }))
const findMany = vi.hoisted(() => vi.fn())
vi.mock("@/lib/document-auth", () => ({ getDocumentCaller: async () => caller.value }))
vi.mock("@/lib/audit-refusals", () => ({ auditDocumentAccessRefusal: vi.fn() }))
vi.mock("@/lib/prisma", () => ({ prisma: { loanApplication: { findMany } } }))

import { GET } from "./route"

const get = () => GET(new NextRequest("http://localhost/api/clients/client-1/signing-packets"), { params: Promise.resolve({ id: "client-1" }) })

beforeEach(() => { findMany.mockReset() })

// Security review of #145: the client's signing packets are its loan
// agreements; a role without the loan book gets none.
describe("GET /api/clients/[id]/signing-packets for a role without the loan book", () => {
  it("returns an empty list to INSURANCE_OFFICER without reading the applications", async () => {
    caller.value = { type: "staff", userId: "io-1", role: "INSURANCE_OFFICER", tenantId: "t1" }
    const res = await get()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual([])
    expect(findMany).not.toHaveBeenCalled()
  })
})
