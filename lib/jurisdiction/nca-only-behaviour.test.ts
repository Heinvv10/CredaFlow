/**
 * Every registered NCA-only API route, actually called under a Lesotho lender:
 * it must answer 404 (a cron, 200 "skipped") before it reads a database, resolves
 * a tenant or does any work. The structural census (nca-only-census.test.ts)
 * says where the gate is; this proves it holds.
 */
import { NextRequest } from "next/server"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { NcaOnlySurfaces } from "./nca-only-registry"
import { resetActiveJurisdiction, setActiveJurisdiction } from "./active"

const reached = vi.hoisted(() => ({ what: [] as string[], tenantAllowed: false }))
const touch = (what: string) => () => { reached.what.push(what); throw new Error(`reached ${what}`) }

vi.mock("@/lib/prisma", () => ({ prisma: new Proxy({}, { get: (_t, name) => touch(`prisma.${String(name)}`)() }) }))
// The export route resolves its tenant before it looks at the report type, so that test allows it.
vi.mock("@/lib/tenant", () => ({
  withTenantContext: async (_req: unknown, run: (tenant: { id: string }) => Promise<Response>) => (reached.tenantAllowed ? run({ id: "t1" }) : touch("withTenantContext")()),
  getTenantFromRequest: async () => (reached.tenantAllowed ? { id: "t1" } : touch("getTenantFromRequest")()),
}))
vi.mock("@/lib/auth", () => ({ auth: async () => ({ user: { id: "u1", email: "u@test.invalid", role: "SUPER_ADMIN", tenantId: "t1" } }) }))
vi.mock("@/lib/auth-guards", () => {
  const user = { id: "u1", email: "u@test.invalid", role: "SUPER_ADMIN", tenantId: "t1" }
  return {
    // PERMISSIONS values are only ever handed to requireApiRole / requireMinRole.
    PERMISSIONS: new Proxy({}, { get: (_t, name) => String(name) }),
    requireApiRole: async () => ({ user }),
    requireMinRole: async () => user,
    canDo: () => true,
    hasMinRole: () => true,
  }
})
vi.mock("@/lib/cron-auth", () => ({ verifyCronSecret: () => null }))

const registry = import.meta.glob<{ default: NcaOnlySurfaces }>("../registry/nca-only/*.ts", { eager: true })
const entries = Object.values(registry).flatMap((m) => Object.entries(m.default))
const routes = import.meta.glob<Record<string, unknown>>("../../app/api/**/route.ts")
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const
type Handler = (req: NextRequest, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>

// Any dynamic segment resolves to "x".
const anyParams = Promise.resolve(new Proxy({}, { get: (_t, key) => (key === "then" ? undefined : "x") }) as Record<string, string>)
const request = (method: string, url: string) =>
  new NextRequest(`http://localhost${url}`, { method, ...(method === "GET" ? {} : { body: "{}", headers: { "content-type": "application/json" } }) })

const apiRoutes = entries.filter(([surface, gate]) => surface.startsWith("app/api/") && gate.gate === "direct")
const exportRoute = entries.find(([surface]) => surface === "app/api/reports/export/route.ts")

beforeEach(() => {
  reached.what.length = 0
  reached.tenantAllowed = false
  setActiveJurisdiction({ jurisdiction: "LS", currency: "LSL" })
})
afterEach(() => resetActiveJurisdiction())

async function load(surface: string): Promise<Record<string, unknown>> {
  const loader = routes[`../../${surface}`]
  if (!loader) throw new Error(`${surface} is not an API route file`)
  return loader()
}

describe("NCA-only API routes under a Lesotho lender", () => {
  it("the registry holds a useful number of API routes", () => {
    expect(apiRoutes.length).toBeGreaterThan(20)
  })

  it.each(apiRoutes.map(([surface]) => [surface]))("%s refuses every method before doing any work", async (surface) => {
    const mod = await load(surface)
    const handlers = METHODS.filter((m) => typeof mod[m] === "function")
    expect(handlers.length, `${surface} exports a handler`).toBeGreaterThan(0)
    for (const method of handlers) {
      const res = await (mod[method] as Handler)(request(method, "/api/x"), { params: anyParams })
      if (surface.startsWith("app/api/cron/")) {
        expect(res.status, `${surface} ${method}`).toBe(200)
        expect(await res.json()).toEqual({ skipped: "not applicable to this lender" })
      } else {
        expect(res.status, `${surface} ${method}`).toBe(404)
      }
    }
    expect(reached.what, `${surface} reached ${reached.what.join(", ")}`).toEqual([])
  })

  it("each NCA-only report export type is refused, and an ordinary one is not", async () => {
    const [, gate] = exportRoute ?? []
    if (!gate || gate.gate !== "branches") throw new Error("the export route is not registered as branches")
    const mod = await load("app/api/reports/export/route.ts")
    reached.tenantAllowed = true
    for (const type of gate.types) {
      const res = await (mod.GET as Handler)(request("GET", `/api/reports/export?type=${type}`), { params: anyParams })
      expect(res.status, `export type ${type}`).toBe(404)
    }
    expect(reached.what).toEqual([])
    // A type that is not NCA-only is not turned away by the jurisdiction gate: it reaches
    // the work (here, the database, which the mock refuses).
    resetActiveJurisdiction()
    const ordinary = await (mod.GET as Handler)(request("GET", "/api/reports/export?type=loans"), { params: anyParams }).catch((e: unknown) => e)
    expect(ordinary instanceof Response ? ordinary.status : "threw").not.toBe(404)
  })
})
