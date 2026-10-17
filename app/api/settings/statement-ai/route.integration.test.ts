/**
 * The Statement AI switch against Postgres: only a SUPER_ADMIN changes it,
 * the change is audited in the same transaction, and the flag reads live.
 *
 *   RUN_STATEMENT_AI_IT=1 DATABASE_URL=postgresql://... \
 *     npx vitest run app/api/settings/statement-ai/route.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import type { UserRole } from "@prisma/client"

const h = vi.hoisted(() => ({ session: null as null | { user: Record<string, unknown> } }))
// The session is the only seam mocked: requireApiRole, the locked role
// re-check, withTenantContext and the audit writer are real.
vi.mock("next/navigation", () => ({ redirect: vi.fn() }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))

import { prisma } from "@/lib/prisma"
import { statementAiEnabled } from "@/lib/statement-ai/enabled"
import { createAiFixture, dropAiFixture, sessionFor, type AiFixture } from "@/lib/statement-ai/statement-ai.integration-fixture"
import { GET, PUT } from "./route"

const RUN = process.env.RUN_STATEMENT_AI_IT === "1"
const suite = RUN ? describe : describe.skip

let slug = ""
const put = (body: unknown) => PUT(new NextRequest("http://localhost/api/settings/statement-ai", { method: "PUT", headers: { "content-type": "application/json", "x-tenant-slug": slug }, body: JSON.stringify(body) }))
const as = (f: AiFixture, role: UserRole) => {
  slug = f.slug
  h.session = sessionFor(f, role)
}

suite("PUT /api/settings/statement-ai against Postgres", () => {
  let f: AiFixture
  beforeAll(async () => { f = await createAiFixture({ featureStatementAi: false, label: "aiset" }) })
  afterAll(async () => { if (f) await dropAiFixture(f) })

  it("refuses every role below SUPER_ADMIN and changes nothing", async () => {
    for (const role of ["ADMIN", "LOAN_ADMIN", "CREDIT_OFFICER", "READONLY"] as UserRole[]) {
      as(f, role)
      expect((await put({ featureStatementAi: true })).status, role).toBe(403)
    }
    expect(await statementAiEnabled(f.tenantId)).toBe(false)
    expect(await prisma.auditLog.count({ where: { tenantId: f.tenantId, action: { startsWith: "STATEMENT_AI_" } } })).toBe(0)
  })

  it("lets a SUPER_ADMIN switch it on and off, each change audited once", async () => {
    as(f, "SUPER_ADMIN")
    expect((await put({ featureStatementAi: "yes" })).status).toBe(400)
    const on = await put({ featureStatementAi: true })
    expect(await on.json()).toMatchObject({ ok: true, changed: true, featureStatementAi: true })
    expect(await statementAiEnabled(f.tenantId)).toBe(true)
    expect(await (await put({ featureStatementAi: true })).json()).toMatchObject({ changed: false })
    await put({ featureStatementAi: false })
    expect(await statementAiEnabled(f.tenantId)).toBe(false)
    const audit = await prisma.auditLog.findMany({ where: { tenantId: f.tenantId, action: { startsWith: "STATEMENT_AI_" } }, orderBy: { createdAt: "asc" } })
    expect(audit.map((a) => [a.action, a.userId, a.newValue])).toEqual([
      ["STATEMENT_AI_ENABLED", f.userIds.SUPER_ADMIN, { featureStatementAi: true }],
      ["STATEMENT_AI_DISABLED", f.userIds.SUPER_ADMIN, { featureStatementAi: false }],
    ])
    as(f, "ADMIN")
    expect(await (await GET(new NextRequest("http://localhost/api/settings/statement-ai", { headers: { "x-tenant-slug": slug } }))).json()).toEqual({ featureStatementAi: false })
  })
})
