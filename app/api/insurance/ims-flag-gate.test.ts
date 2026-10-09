// app/api/insurance/ims-flag-gate.test.ts
//
// Floor test for the per-tenant IMS kill switch. app/(dashboard)/insurance/
// layout.tsx redirects the staff PAGES when featureIms is off, but until
// requireImsEnabled was wired in, every route under app/api/insurance/** was
// still reachable by any authenticated staff member with the right role — "off"
// meant hidden, not disabled.
//
// The route list is DISCOVERED, not maintained by hand. A hand-written list
// covers exactly the routes someone remembered to add to it: route #13, shipped
// next month without the guard, would have been caught by nobody. Every
// route.ts under this directory and every HTTP method it exports is enumerated
// below at run time, so a new ungated handler fails this suite the moment it
// exists.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { readdirSync } from "node:fs"
import { fileURLToPath } from "node:url"
import path from "node:path"

const { tenantConfigFindUnique, guardResults, prismaCalls } = vi.hoisted(() => ({
  // The guard's own lookup. Separate from the recording proxy below so that
  // "nothing below the gate ran" stays checkable now that the gate itself reads
  // the live TenantConfig row rather than a cached resolver.
  tenantConfigFindUnique: vi.fn(),
  // What the REAL guard returned on each call: null = let through, Response = blocked.
  guardResults: [] as (Response | null)[],
  // Every OTHER Prisma model/method touched, so "nothing below the gate ran" is checkable.
  prismaCalls: [] as string[],
}))

// The guard itself is NOT stubbed — it is wrapped, so each route's call to it is
// observable while the real flag logic still decides the outcome. Asserting on
// the gate's own return value is the only way to tell its 404 apart from a
// route's legitimate "policy not found" 404.
vi.mock("@/lib/insurance/require-ims-enabled", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/insurance/require-ims-enabled")>()
  return {
    requireImsEnabled: async (tenantId: string) => {
      const result = await actual.requireImsEnabled(tenantId)
      guardResults.push(result)
      return result
    },
  }
})

// resolveFeatureFlags stays REAL (see lib/insurance/require-ims-enabled.test.ts).
vi.mock("@/lib/tenant", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/tenant")>()),
  withTenantContext: (_req: unknown, fn: (t: { id: string; name: string }) => unknown) =>
    fn({ id: "tenant-1", name: "Test Tenant" }),
}))

// The role check must PASS, so that a 404 here can only have come from the
// feature gate and never from authz.
vi.mock("@/lib/auth-guards", () => ({
  requireApiRole: vi.fn().mockResolvedValue({
    user: { id: "user-1", email: "officer@acme-lending.example" },
  }),
}))

// Nothing below the gate should run; a real Prisma client must never be
// constructed just because a route module was imported.
vi.mock("@/lib/prisma", () => ({
  prisma: new Proxy(
    {},
    {
      get: (_t, model: string) =>
        model === "tenantConfig"
          ? { findUnique: tenantConfigFindUnique }
          : new Proxy(
              {},
              {
                get: (_m, method: string) => async () => {
                  prismaCalls.push(`${model}.${method}`)
                  return null
                },
              }
            ),
    }
  ),
}))

vi.mock("@/lib/audit", () => ({
  logAudit: vi.fn().mockResolvedValue(undefined),
  AuditAction: new Proxy({}, { get: (_t, k) => String(k) }),
}))

type Handler = (req: NextRequest, ctx: never) => Promise<Response>

type Case = {
  name: string
  method: string
  url: string
  load: () => Promise<Record<string, unknown>>
  export: string
  params: Record<string, string>
}

const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const

const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * Every directory under this one holding a route.ts, as a "/"-joined path
 * relative to this file ("." for this directory itself).
 */
function walkRouteDirs(dir: string, prefix = "."): string[] {
  const entries = readdirSync(dir, { withFileTypes: true })
  const found = entries.some((e) => e.isFile() && e.name === "route.ts") ? [prefix] : []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      found.push(...walkRouteDirs(path.join(dir, entry.name), prefix === "." ? entry.name : `${prefix}/${entry.name}`))
    }
  }
  return found.sort()
}

const ROUTE_DIRS = walkRouteDirs(HERE)

// Vite needs a statically analysable specifier, and a plain dynamic import with
// a variable path only reaches one directory level — not enough for
// policies/[id]/beneficiaries/[beneficiaryId]. import.meta.glob is the
// supported form, so it supplies the loaders while the fs walk above stays the
// authoritative list; a route directory the glob did not match throws below
// rather than being silently skipped. The type is declared here because
// tsconfig does not pull in vite/client.
declare global {
  interface ImportMeta {
    glob<T>(pattern: string): Record<string, () => Promise<T>>
  }
}

const ROUTE_MODULES = import.meta.glob<Record<string, unknown>>("./**/route.ts")

function loadRoute(routeDir: string): () => Promise<Record<string, unknown>> {
  const load = ROUTE_MODULES[`./${routeDir === "." ? "" : `${routeDir}/`}route.ts`]
  if (!load) throw new Error(`No module discovered for ./${routeDir}/route.ts`)
  return load
}

/** "policies/[id]/beneficiaries" -> a URL and the params a handler gets. */
function requestShape(routeDir: string): { url: string; params: Record<string, string> } {
  const params: Record<string, string> = {}
  const segments = (routeDir === "." ? [] : routeDir.split("/"))
    .map((segment) => {
      const dynamic = segment.match(/^\[(?:\.\.\.)?(.+)\]$/)
      if (!dynamic) return segment
      const name = dynamic[1]
      params[name] = `${name}-1`
      return params[name]
    })
  return { url: `http://localhost/api/insurance/${segments.join("/")}`, params }
}

const CASES: Case[] = (
  await Promise.all(
    ROUTE_DIRS.map(async (routeDir) => {
      const load = loadRoute(routeDir)
      const mod = await load()
      const { url, params } = requestShape(routeDir)
      return HTTP_METHODS.filter((method) => typeof mod[method] === "function").map((method) => ({
        name: `${method} /api/insurance/${routeDir === "." ? "" : routeDir}`,
        method,
        url,
        load,
        export: method,
        params,
      }))
    })
  )
).flat()

async function invoke(c: Case): Promise<Response> {
  const mod = await c.load()
  const handler = mod[c.export] as Handler
  const req = new NextRequest(c.url, {
    method: c.method,
    ...(c.method === "GET" || c.method === "DELETE"
      ? {}
      : { body: "{}", headers: { "content-type": "application/json" } }),
  })
  const ctx = { params: Promise.resolve(c.params) } as unknown as never
  return handler(req, ctx)
}

beforeEach(() => {
  process.env.NEXTAUTH_SECRET = "test-secret-do-not-use-in-prod-1234567890abcdef"
})

afterEach(() => {
  vi.clearAllMocks()
  vi.resetModules()
  guardResults.length = 0
  prismaCalls.length = 0
})

describe("app/api/insurance/** — featureIms kill switch", () => {
  describe("route discovery", () => {
    it("finds route files on disk at all", () => {
      // A discovery bug that returned nothing would leave this suite green with
      // zero routes actually gated, which is the failure mode a hand-written
      // list at least made visible.
      expect(ROUTE_DIRS.length).toBeGreaterThan(0)
    })

    it("enumerates at least one handler per route file", () => {
      const covered = new Set(CASES.map((c) => c.url))
      expect(covered.size).toBe(ROUTE_DIRS.length)
      expect(CASES.length).toBeGreaterThanOrEqual(ROUTE_DIRS.length)
    })
  })

  describe("flag OFF → 404 for every handler", () => {
    for (const c of CASES) {
      it(`${c.name} returns 404`, async () => {
        tenantConfigFindUnique.mockResolvedValue({ featureIms: false, featureCrm: true })

        const res = await invoke(c)

        // The gate ran exactly once and blocked...
        expect(guardResults).toHaveLength(1)
        expect(guardResults[0]?.status).toBe(404)
        // ...and its response is what the handler returned.
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: "Not found" })
        // Nothing below the gate executed.
        expect(prismaCalls).toEqual([])
      })
    }
  })

  describe("flag resolution THROWS → still blocked, never open", () => {
    for (const c of CASES) {
      it(`${c.name} returns 404`, async () => {
        tenantConfigFindUnique.mockRejectedValue(new Error("db unreachable"))

        const res = await invoke(c)

        expect(guardResults[0]?.status).toBe(404)
        expect(res.status).toBe(404)
        expect(prismaCalls).toEqual([])
      })
    }
  })

  describe("flag ON → the gate is a no-op", () => {
    for (const c of CASES) {
      it(`${c.name} is not blocked by the gate`, async () => {
        tenantConfigFindUnique.mockResolvedValue({ featureIms: true, featureCrm: false })

        await invoke(c).catch(() => null)

        // The handler's own status varies (400/404/422/500 are all legitimate
        // for an empty body against a stubbed Prisma), so assert on the gate
        // instead: it ran, and it let the request through.
        expect(tenantConfigFindUnique).toHaveBeenCalledWith({
          where: { tenantId: "tenant-1" },
          select: { featureCrm: true, featureIms: true },
        })
        expect(guardResults).toEqual([null])
      })
    }
  })
})
