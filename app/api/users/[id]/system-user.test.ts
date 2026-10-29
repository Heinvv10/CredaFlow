import { beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"

const h = vi.hoisted(() => ({ findFirst: vi.fn(), upsert: vi.fn(), fpUpsert: vi.fn() }))

vi.mock("@/lib/prisma", () => ({ prisma: { user: { findFirst: h.findFirst }, coiDeclaration: { upsert: h.upsert }, fitAndProper: { upsert: h.fpUpsert } } }))
vi.mock("@/lib/auth-guards", () => ({ requireApiRole: vi.fn(async () => ({ error: null, user: { id: "admin-1", role: "ADMIN" } })) }))
vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => ({ user: { id: "admin-1", role: "ADMIN" } })) }))
vi.mock("@/lib/tenant", () => ({ withTenantContext: (_req: unknown, fn: (t: { id: string }) => unknown) => fn({ id: "t1" }) }))
vi.mock("@/lib/audit", () => ({ logAudit: vi.fn() }))

import { POST as coiPost } from "./coi/route"
import { PUT as fitAndProperPut } from "./fit-and-proper/route"

const req = (body: object) => new NextRequest("http://localhost/api/users/sys/x", { method: "POST", body: JSON.stringify(body) })
const params = { params: Promise.resolve({ id: "sys-1" }) }

beforeEach(() => { h.findFirst.mockReset().mockResolvedValue(null); h.upsert.mockReset(); h.fpUpsert.mockReset() })

describe("the automated decisioning account has no staff records of its own", () => {
  it("a fit-and-proper record cannot be written for it", async () => {
    expect((await fitAndProperPut(req({ licenceNumber: "X" }), params)).status).toBe(404)
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sys-1", tenantId: "t1", isSystem: false } }))
    expect(h.fpUpsert).not.toHaveBeenCalled()
  })
  it("a conflict-of-interest declaration cannot be recorded for it", async () => {
    expect((await coiPost(req({ hasConflict: false }), params)).status).toBe(404)
    expect(h.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: "sys-1", tenantId: "t1", isSystem: false } }))
    expect(h.upsert).not.toHaveBeenCalled()
  })
})
