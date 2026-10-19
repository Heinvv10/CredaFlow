import { readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

// The guard census: every staff and client guard refuses a DEALER session,
// and every lib module that reads the session is listed here, so a new guard
// fails this suite until it is classified. The dealer host gate
// (lib/proxy/dealer-host.ts) keeps a DEALER session away from staff and
// client routes; this is the layer behind it. The session is a dealer
// admin with every claim a guard could look for, sharing its email with a
// client of the same lender.
const h = vi.hoisted(() => ({
  session: null as null | { user: Record<string, unknown> },
}))

class Redirect extends Error {}
class NotFound extends Error {}

vi.mock("next/navigation", () => ({
  redirect: (to: string) => { throw new Redirect(to) },
  notFound: () => { throw new NotFound("not found") },
}))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-cf-request-path": "/clients" }) }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("@/lib/prisma", () => ({
  prisma: {
    user: { findUnique: async () => null },
    // A client with the dealer user's email: a guard that looks a non-staff
    // session up by email would resolve the dealer as this client.
    client: { findFirst: async () => ({ id: "client-1", email: "shared@lender.test" }) },
    tenantConfig: { findUnique: async () => ({ featureCrm: true, featureIms: true, featureAssetFinance: true }) },
    tenant: { findFirst: async () => null, findUnique: async () => null, findMany: async () => [] },
  },
}))

import * as authGuards from "@/lib/auth-guards"
import * as documentAuth from "@/lib/document-auth"
import * as inboxAuthz from "@/lib/inbox/authz"
import * as signingOtp from "@/lib/signing-otp/caller"
import * as portalRoute from "@/lib/asset-finance/portal-route"
import * as portalPage from "@/lib/asset-finance/portal-page"
import * as sessionTenant from "@/lib/session-tenant"
import * as consoleAuth from "@/lib/operator/console-auth"
import { PERMISSIONS } from "@/lib/registry/generated/permissions"
import { ROLE_HIERARCHY as CLIENT_SAFE_HIERARCHY, canDo as clientSafeCanDo, hasMinRole as clientSafeHasMinRole } from "@/lib/permissions"
import type { UserRole } from "@prisma/client"

const DEALER = {
  user: {
    id: "du-1", email: "shared@lender.test", name: "TEST Dealer", role: "DEALER", tenantId: "tenant-1",
    dealerId: "dealer-1", dealerRole: "DEALER_ADMIN", totpVerified: true, totpEnrolmentRequired: false, tokenVersion: 0,
  },
}
const ALL_STAFF_ROLES: UserRole[] = [...authGuards.ROLE_HIERARCHY]
const req = () => new Request("https://app.lender.example/api/x")

/** Resolves to "refused" when the guard redirects, 404s, returns an error response or a null caller. */
async function outcome(run: () => Promise<unknown>): Promise<"refused" | "allowed"> {
  try {
    const result = await run()
    if (result === null) return "refused"
    if (result instanceof Response) return result.status >= 400 ? "refused" : "allowed"
    if (result && typeof result === "object" && "error" in result && (result as { error?: unknown }).error) return "refused"
    return "allowed"
  } catch (error) {
    if (error instanceof Redirect || error instanceof NotFound) return "refused"
    throw error
  }
}

/** Every session-reading guard, by module and export, with how to call it. */
const GUARDS: Record<string, Record<string, () => Promise<unknown>>> = {
  "lib/auth-guards.ts": {
    requireRole: () => authGuards.requireRole([...ALL_STAFF_ROLES, "CLIENT"]),
    requireMinRole: () => authGuards.requireMinRole("READONLY"),
    requireApiRole: () => authGuards.requireApiRole("READONLY"),
    requireLoanBookStaff: () => authGuards.requireLoanBookStaff("READONLY"),
    requireLoanBookPage: () => authGuards.requireLoanBookPage(),
    requireOwnerOrStaff: () => authGuards.requireOwnerOrStaff("du-1", "READONLY"),
  },
  "lib/document-auth.ts": { getDocumentCaller: () => documentAuth.getDocumentCaller() },
  "lib/inbox/authz.ts": {
    requireCommsAgent: () => inboxAuthz.requireCommsAgent(),
    requireCommsAgentPage: () => inboxAuthz.requireCommsAgentPage(),
  },
  "lib/signing-otp/caller.ts": { signingOtpCaller: () => signingOtp.signingOtpCaller() },
  "lib/asset-finance/portal-route.ts": {
    getPortalClient: () => portalRoute.getPortalClient(),
    withPortalEntity: () => portalRoute.withPortalEntity(req(), null, async () => new Response("ok")),
  },
  "lib/asset-finance/portal-page.ts": {
    requirePortalAssetFinancePage: () => portalPage.requirePortalAssetFinancePage(),
    requirePortalEntityPage: () => portalPage.requirePortalEntityPage("entity-1"),
  },
  "lib/session-tenant.ts": {
    getStaffTenantId: () => sessionTenant.getStaffTenantId(),
    getPortalTenantId: () => sessionTenant.getPortalTenantId(),
  },
  "lib/operator/console-auth.ts": {
    requireOperatorPage: () => consoleAuth.requireOperatorPage(),
    requireOperatorApi: () => consoleAuth.requireOperatorApi(),
  },
}

/** Session readers that are not principal guards, and why. */
const NOT_GUARDS: Record<string, string> = {
  "lib/auth-session.ts": "getSession: the cached session read every guard above uses",
  "lib/tenant.ts": "withTenantContext binds a principal's tenant to the host's; role checks come from a guard above",
  "lib/audit-refusals.ts": "reads the session only to name the actor on a refusal it records",
  "lib/documents/tenant-refusal.ts": "reads the session only to audit a tenant-binding refusal",
  "lib/dealer/guards.ts": "the dealer guard itself (lib/dealer/guards.test.ts)",
}

/** Exports of the guard modules that read no session: helpers, constants, types at runtime. */
const NON_SESSION_EXPORTS: Record<string, string[]> = {
  "lib/auth-guards.ts": [
    "redirectStaleSession", "NO_ACCESS_PAGE", "ROLE_HIERARCHY", "hasMinRole", "staffUserWriteRefusal", "refuseStaffUserWrite",
    "refuseLockedStaffUserWrite", "staffUserWriteConflict", "PERMISSIONS", "canDo",
  ],
  "lib/document-auth.ts": ["ALLOWED_MIME_TYPES", "MAX_FILE_SIZE", "VALID_DOC_TYPES", "MAGIC_BYTE_PREFIX", "matchesMagic", "logDocumentAccess", "logDocumentContentAccess"],
  "lib/inbox/authz.ts": ["isCommsAgentAllowed"],
  "lib/signing-otp/caller.ts": [],
  "lib/asset-finance/portal-route.ts": [],
  "lib/asset-finance/portal-page.ts": [],
  "lib/session-tenant.ts": [],
  "lib/operator/console-auth.ts": ["operatorTenant"],
}

const MODULES: Record<string, Record<string, unknown>> = {
  "lib/auth-guards.ts": authGuards, "lib/document-auth.ts": documentAuth, "lib/inbox/authz.ts": inboxAuthz,
  "lib/signing-otp/caller.ts": signingOtp, "lib/asset-finance/portal-route.ts": portalRoute, "lib/asset-finance/portal-page.ts": portalPage,
  "lib/session-tenant.ts": sessionTenant, "lib/operator/console-auth.ts": consoleAuth,
}

const ROOT = path.resolve(__dirname, "../..")
const SESSION_READ = /import\(["'](?:@\/lib|\.{1,2})\/auth["']\)|from ["'](?:@\/lib\/auth|@\/lib\/auth-session|\.{1,2}\/auth|\.\/auth-session)["']/

function sessionReadingModules(dir = path.join(ROOT, "lib")): string[] {
  const found: string[] = []
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry !== "generated" && entry !== "__tests__" && entry !== "__fixtures__") found.push(...sessionReadingModules(full))
      continue
    }
    if (!/\.tsx?$/.test(entry) || /\.test\.|test-helpers|fixture/.test(entry)) continue
    if (SESSION_READ.test(readFileSync(full, "utf8"))) found.push(path.relative(ROOT, full))
  }
  return found.sort()
}

beforeEach(() => { h.session = DEALER })

describe("guard census: a DEALER session is refused by every staff and client guard", () => {
  it("lists every lib module that reads the session", () => {
    const known = [...Object.keys(GUARDS), ...Object.keys(NOT_GUARDS), "lib/auth.ts", "lib/auth-edge.ts"].sort()
    for (const file of sessionReadingModules()) expect(known, `${file} reads the session: classify it here`).toContain(file)
  })

  it.each(Object.keys(MODULES))("classifies every export of %s", (file) => {
    const exported = Object.keys(MODULES[file])
    const classified = [...Object.keys(GUARDS[file]), ...NON_SESSION_EXPORTS[file]]
    expect(exported.filter((name) => !classified.includes(name)), `${file}: unclassified exports`).toEqual([])
  })

  for (const [file, guards] of Object.entries(GUARDS)) {
    it.each(Object.keys(guards))(`${file} %s refuses it`, async (name) => {
      expect(await outcome(guards[name])).toBe("refused")
    })
  }

  it("never resolves a dealer as the client that shares its email", async () => {
    expect(await documentAuth.getDocumentCaller()).toBeNull()
  })

  it("grants it no role and no permission, in either permission map", () => {
    for (const role of ALL_STAFF_ROLES) {
      expect(authGuards.hasMinRole("DEALER", role)).toBe(false)
      expect(clientSafeHasMinRole("DEALER" as UserRole, role)).toBe(false)
    }
    for (const permission of Object.keys(PERMISSIONS)) {
      expect(authGuards.canDo("DEALER", permission as authGuards.PermissionKey), permission).toBe(false)
      expect(clientSafeCanDo("DEALER", permission), permission).toBe(false)
    }
    expect(CLIENT_SAFE_HIERARCHY).not.toContain("DEALER")
  })
})
