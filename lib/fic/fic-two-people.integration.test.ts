/**
 * F12 on the FIC controls, through the real routes on real Postgres: an account the uploader or the case's raiser created is not the second
 * reviewer; a colleague is; and with the lender's second-reviewer rule off, the two-people rule is off with it.
 *
 *   RUN_SCREENING_IT=1 DATABASE_URL=postgresql://... npx vitest run lib/fic/fic-two-people.integration.test.ts
 */
import { randomUUID } from "node:crypto"
import { PrismaClient } from "@prisma/client"
import { NextRequest } from "next/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"

vi.mock("@/lib/auth", () => ({ auth: vi.fn(async () => null) }))

import { PATCH as approveRmcp } from "@/app/api/compliance/fic/rmcp/[id]/route"
import { PATCH as decideStr } from "@/app/api/compliance/fic/str/[id]/route"
import { auth } from "@/lib/auth"

const suite = process.env.RUN_SCREENING_IT === "1" ? describe.sequential : describe.skip
const db = new PrismaClient()
const token = randomUUID().replaceAll("-", "").slice(0, 12)
const tenantId = `tenant_fic2p_${token}`
const person = (name: string) => `${name}_${token}`
const [maker, puppet, colleague] = ["maker", "puppet", "colleague"].map(person)
const signIn = (id: string) => vi.mocked(auth).mockResolvedValue({ user: { id, email: `${id}@test.invalid`, role: "ADMIN", tenantId, totpVerified: true, name: id } } as never)
const call = async (route: typeof approveRmcp, path: string, id: string, by: string, body: object) => {
  signIn(by)
  const res = await route(new NextRequest(`http://localhost${path}`, { method: "PATCH", headers: { "x-tenant-slug": tenantId, "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id }) })
  return { status: res.status, body: (await res.json()) as Record<string, unknown> }
}
const rmcp = async (version: number) => (await db.rmcpDocument.create({ data: {
  tenantId, version, title: "RMCP", fileName: "rmcp.pdf", mimeType: "application/pdf", storagePath: `/synthetic/rmcp-${version}.pdf`, sha256: "a".repeat(64), fileSize: 1, uploadedById: maker, reviewDueAt: new Date("2027-11-01T00:00:00Z"),
} })).id
const str = async (n: number) => (await db.suspiciousReportCase.create({ data: { tenantId, reference: `STR-${n}-${token}`, kind: "SUSPICIOUS_TRANSACTION", grounds: "Synthetic grounds for the proof", raisedById: maker } })).id
const close = { status: "CLOSED_NO_REPORT", assessmentNote: "Reviewed the activity: nothing to report to the FIC after a full assessment." }

suite("the FIC controls read the two-people rule (real routes, real Postgres)", () => {
  beforeAll(async () => {
    await db.tenant.create({ data: { id: tenantId, slug: tenantId, name: "FIC two people" } })
    await db.tenantConfig.create({ data: { tenantId, requireStaffTotp: true, requireSecondReviewer: true } })
    await db.user.createMany({ data: [maker, puppet, colleague].map((id) => ({ id, tenantId, email: `${id}@test.invalid`, password: "synthetic", name: id, role: "ADMIN" as const })) })
    await db.auditLog.create({ data: { tenantId, userId: maker, action: "USER_CREATED", entity: "User", entityId: puppet } })
  })
  afterAll(async () => { await db.$disconnect() })

  it("RMCP: the uploader's own account cannot approve the version; a colleague can", async () => {
    const id = await rmcp(1)
    const path = `/api/compliance/fic/rmcp/${id}`
    expect(await call(approveRmcp, path, id, puppet, { approvalNote: "Read in full" })).toMatchObject({ status: 403, body: { error: expect.stringContaining("Two people") } })
    expect((await db.rmcpDocument.findUniqueOrThrow({ where: { id } })).approvedById).toBeNull()
    expect((await call(approveRmcp, path, id, colleague, { approvalNote: "Read in full" })).status).toBe(200)
  })

  it("STR: the raiser's own account cannot decide the case, though it may take it under review; a colleague can", async () => {
    const id = await str(1)
    const path = `/api/compliance/fic/str/${id}`
    expect((await call(decideStr as typeof approveRmcp, path, id, puppet, { status: "UNDER_REVIEW" })).status).toBe(200)
    expect(await call(decideStr as typeof approveRmcp, path, id, puppet, close)).toMatchObject({ status: 403, body: { error: expect.stringContaining("Two people") } })
    expect((await db.suspiciousReportCase.findUniqueOrThrow({ where: { id } })).status).toBe("UNDER_REVIEW")
    expect((await call(decideStr as typeof approveRmcp, path, id, colleague, close)).status).toBe(200)
  })

  it("with the lender's second-reviewer rule off, neither control asks", async () => {
    await db.tenantConfig.update({ where: { tenantId }, data: { requireSecondReviewer: false } })
    const version = await rmcp(2)
    expect((await call(approveRmcp, `/api/compliance/fic/rmcp/${version}`, version, puppet, { approvalNote: "Read in full" })).status).toBe(200)
  })
})
