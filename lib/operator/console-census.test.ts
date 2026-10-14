import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import { renderToStaticMarkup } from "react-dom/server"
import { NextRequest } from "next/server"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { ReactElement } from "react"

// The operator console census: every page and layout under app/(operator) and
// every route under app/api/operator is listed here with what it may do, and
// is then RUN against a recording Prisma whose borrower tables are full of
// sentinels. Operator code may count borrower rows; it may read them only
// through a lender's active support grant, after the grant decision has
// audited the use. A new console file fails the census until it is listed.
const h = vi.hoisted(() => ({
  calls: [] as Array<{ model: string; op: string; args: unknown }>,
  fixture: { grant: null as null | { id: string; expiresAt: Date }, operatorRole: "OPERATOR_ADMIN" as "OPERATOR_ADMIN" | "OPERATOR_SUPPORT" },
  session: null as null | { user: Record<string, unknown> },
}))

vi.mock("@/lib/prisma", async () => {
  const { recordingPrisma } = await import("./console-census.test-helpers")
  return { prisma: recordingPrisma(h.calls, () => h.fixture) }
})
vi.mock("@/lib/auth-session", () => ({ getSession: async () => h.session }))
vi.mock("@/lib/auth", () => ({ auth: async () => h.session }))
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-cf-request-method": "GET", "x-cf-request-id": `rid-${h.calls.length}` }) }))
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND") },
  redirect: (url: string) => { throw new Error(`NEXT_REDIRECT ${url}`) },
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}))
vi.mock("@/lib/email", () => ({ sendEmail: async () => ({ ok: true, dev: true }) }))
// Needs the root layout's ThemeProvider, which a page rendered alone does not have.
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }))
vi.stubEnv("NEXTAUTH_URL", "https://app.census.invalid")
vi.stubEnv("OPERATOR_APP_HOST", "console.census.invalid")

import ConsoleLayout from "@/app/(operator)/operator/(console)/layout"
import LendersPage from "@/app/(operator)/operator/(console)/page"
import LenderPage from "@/app/(operator)/operator/(console)/lenders/[id]/page"
import NewLenderPage from "@/app/(operator)/operator/(console)/lenders/new/page"
import SupportPage from "@/app/(operator)/operator/(console)/lenders/[id]/support/page"
import UsagePage from "@/app/(operator)/operator/(console)/usage/page"
import GrantsPage from "@/app/(operator)/operator/(console)/grants/page"
import UsersPage from "@/app/(operator)/operator/(console)/users/page"
import LoginPage from "@/app/(operator)/operator/login/page"
import SetPasswordPage from "@/app/(operator)/operator/set-password/page"
import SecurityPage from "@/app/(operator)/operator/security/page"
import * as lendersApi from "@/app/api/operator/lenders/route"
import * as statusApi from "@/app/api/operator/lenders/[id]/status/route"
import * as adminResetApi from "@/app/api/operator/lenders/[id]/admin-reset/route"
import * as usersApi from "@/app/api/operator/users/route"
import * as deactivateApi from "@/app/api/operator/users/[id]/deactivate/route"
import * as userResetApi from "@/app/api/operator/users/[id]/reset/route"
import * as totpApi from "@/app/api/operator/totp/route"
import { validFile } from "@/scripts/lender/tenant-config.test-helpers"
import { SEALED_CREDENTIAL_FIELDS } from "@/lib/integrations/tenant-credentials"
import { auditReads, borrowerReads, credentialReads, SENTINEL, T1 } from "./console-census.test-helpers"

/** public: no session, no data. self: the caller's own account. aggregate: counts only. grant: borrower rows through a grant. admin: OPERATOR_ADMIN writes, no borrower rows. */
type Kind = "public" | "self" | "aggregate" | "grant" | "admin"
type Entry = { kind: Kind; run: () => Promise<string> }

const params = { params: Promise.resolve({ id: T1 }) }
async function render(el: Promise<ReactElement> | ReactElement): Promise<string> {
  return renderToStaticMarkup(await el)
}
async function call(handler: (req: NextRequest, ctx: typeof params) => Promise<Response>, method: string, body?: unknown): Promise<string> {
  const req = new NextRequest(`https://console.census.invalid/api/x`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  const res = await handler(req, params)
  return `${res.status} ${await res.text()}`
}
const provisionBody = { ...validFile(), slug: "census-new", admin: { email: "first-admin@census.invalid", name: "First Admin" } }

const CENSUS: Record<string, Entry> = {
  "app/(operator)/operator/login/page.tsx": { kind: "public", run: () => render(LoginPage()) },
  "app/(operator)/operator/set-password/page.tsx": { kind: "public", run: () => render(SetPasswordPage()) },
  "app/(operator)/operator/security/page.tsx": { kind: "self", run: () => render(SecurityPage()) },
  "app/(operator)/operator/(console)/layout.tsx": { kind: "aggregate", run: () => render(ConsoleLayout({ children: null })) },
  "app/(operator)/operator/(console)/page.tsx": { kind: "aggregate", run: () => render(LendersPage()) },
  "app/(operator)/operator/(console)/lenders/[id]/page.tsx": { kind: "aggregate", run: () => render(LenderPage(params)) },
  "app/(operator)/operator/(console)/lenders/new/page.tsx": { kind: "aggregate", run: () => render(NewLenderPage()) },
  "app/(operator)/operator/(console)/usage/page.tsx": { kind: "aggregate", run: () => render(UsagePage({ searchParams: Promise.resolve({ month: "2026-09" }) })) },
  "app/(operator)/operator/(console)/grants/page.tsx": { kind: "aggregate", run: () => render(GrantsPage()) },
  "app/(operator)/operator/(console)/users/page.tsx": { kind: "aggregate", run: () => render(UsersPage()) },
  "app/(operator)/operator/(console)/lenders/[id]/support/page.tsx": { kind: "grant", run: () => render(SupportPage(params)) },
  "app/api/operator/lenders/route.ts": { kind: "admin", run: () => call(lendersApi.POST, "POST", provisionBody) },
  "app/api/operator/lenders/[id]/status/route.ts": { kind: "admin", run: () => call(statusApi.POST, "POST", { status: "SUSPENDED", reason: "Census" }) },
  "app/api/operator/lenders/[id]/admin-reset/route.ts": { kind: "admin", run: () => call(adminResetApi.POST, "POST", { userId: "u1" }) },
  "app/api/operator/users/route.ts": { kind: "admin", run: () => call(usersApi.POST, "POST", { email: "new@operator.invalid", name: "New", role: "OPERATOR_SUPPORT" }) },
  "app/api/operator/users/[id]/deactivate/route.ts": { kind: "admin", run: () => call(deactivateApi.POST, "POST") },
  "app/api/operator/users/[id]/reset/route.ts": { kind: "admin", run: () => call(userResetApi.POST, "POST") },
  "app/api/operator/totp/route.ts": {
    kind: "self",
    run: async () => `${await call(() => totpApi.GET(), "GET")} ${await call(totpApi.POST, "POST", { secret: "JBSWY3DPEHPK3PXP", code: "000000" })}`,
  },
}

function consoleFiles(): string[] {
  const out: string[] = []
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name)
      if (statSync(full).isDirectory()) walk(full)
      else if (/^(page|layout|route)\.tsx?$/.test(name)) out.push(path.relative(process.cwd(), full).split(path.sep).join("/"))
    }
  }
  walk(path.join(process.cwd(), "app/(operator)"))
  walk(path.join(process.cwd(), "app/api/operator"))
  return out.sort()
}

const operatorSession = (role: "OPERATOR_ADMIN" | "OPERATOR_SUPPORT") => ({
  user: { id: "operator-user-census-1", email: "me@operator.invalid", name: "Me", role, operatorId: "operator-census-1", tenantId: null, totpVerified: true, totpEnrolmentRequired: false },
})
const settle = (p: Promise<string>) => p.catch((e: Error) => `THREW ${e.message}`)

beforeEach(() => {
  h.calls.length = 0
  h.fixture.grant = null
  h.fixture.operatorRole = "OPERATOR_ADMIN"
  h.session = operatorSession("OPERATOR_ADMIN")
})

describe("operator console census", () => {
  it("lists every operator page, layout and API route, and nothing that no longer exists", () => {
    expect(consoleFiles()).toEqual(Object.keys(CENSUS).sort())
  })

  describe.each(Object.entries(CENSUS))("%s", (_file, entry) => {
    it("reads no borrower row, no credential and no audit row without a grant, and shows no borrower value", async () => {
      const out = await settle(entry.run())
      // It ran to the end as an OPERATOR_ADMIN would (not a refusal that proves nothing).
      expect(out).not.toMatch(/^THREW|^40[13] /)
      if (entry.kind === "admin") expect(out).toMatch(/^20[01] /)
      expect(borrowerReads(h.calls)).toEqual([])
      expect(credentialReads(h.calls, SEALED_CREDENTIAL_FIELDS)).toEqual([])
      expect(auditReads(h.calls)).toEqual([])
      expect(out).not.toContain(SENTINEL)
    })

    it("touches nothing for a visitor with no session", async () => {
      h.session = null
      await settle(entry.run())
      expect(h.calls.filter((c) => c.model !== "Operator")).toEqual([])
    })

    if (entry.kind === "admin") {
      it("refuses OPERATOR_SUPPORT before touching the database", async () => {
        h.session = operatorSession("OPERATOR_SUPPORT")
        expect(await settle(entry.run())).toMatch(/^403 /)
        expect(h.calls).toEqual([])
      })
    }

    if (entry.kind !== "public") {
      it("refuses a lender staff session and an operator session without a verified TOTP", async () => {
        for (const user of [
          { id: "u1", email: "s@lender.invalid", role: "SUPER_ADMIN", tenantId: T1, totpVerified: true, totpEnrolmentRequired: false },
          { ...operatorSession("OPERATOR_ADMIN").user, totpVerified: false, totpEnrolmentRequired: true },
        ]) {
          h.calls.length = 0
          h.session = { user }
          const out = await settle(entry.run())
          if (entry.kind === "self" && user.role !== "SUPER_ADMIN") continue // enrolment is for exactly this session
          expect(out).toMatch(/^(40[13] |THREW NEXT_(NOT_FOUND|REDIRECT))/)
          expect(borrowerReads(h.calls)).toEqual([])
        }
      })
    }
  })

  it("shows OPERATOR_SUPPORT neither the new-lender page nor operator user management", async () => {
    h.session = operatorSession("OPERATOR_SUPPORT")
    for (const file of ["app/(operator)/operator/(console)/lenders/new/page.tsx", "app/(operator)/operator/(console)/users/page.tsx"]) {
      expect(await settle(CENSUS[file].run()), file).toBe("THREW NEXT_NOT_FOUND")
    }
    expect(h.calls).toEqual([])
  })

  describe("the grant page with an active grant", () => {
    it("shows the borrower summary only after the use is audited, read-only, with the expiry banner", async () => {
      h.fixture.grant = { id: "grant-1", expiresAt: new Date("2026-10-20T10:00:00Z") }
      const out = await CENSUS["app/(operator)/operator/(console)/lenders/[id]/support/page.tsx"].run()
      const used = h.calls.findIndex((c) => c.model === "AuditLog" && c.op === "create" && JSON.stringify(c.args).includes("SUPPORT_ACCESS_USED"))
      const firstRead = h.calls.findIndex((c) => borrowerReads([c]).length > 0)
      expect(used).toBeGreaterThanOrEqual(0)
      expect(firstRead).toBeGreaterThan(used)
      expect(borrowerReads(h.calls).every((c) => c.op === "findMany")).toBe(true)
      expect(out).toContain("Support access — read only, expires")
      expect(out).toContain(SENTINEL)
      // ID numbers stay masked even through a grant.
      expect(out).not.toContain(`${SENTINEL}-9999`)
    })
  })
})
