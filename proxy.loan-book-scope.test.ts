import { existsSync, readdirSync, readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { NextRequest } from "next/server"
import { isLoanBookPath, LOAN_BOOK_APIS, LOAN_BOOK_PAGES } from "@/lib/security/loan-book-scope"

// The edge auth wrapper as identity: the default export IS the handler, and
// `req.auth` is the session it reads (as proxy.client-pages.test.ts).
vi.mock("@/lib/auth-edge", () => ({ auth: (handler: unknown) => handler }))
const proxy = (await import("./proxy")).default as unknown as (req: NextRequest) => Promise<Response>

function visit(pathname: string, role: string, method = "GET") {
  const req = new NextRequest(`http://localhost${pathname}`, { method, headers: { host: "localhost" } }) as NextRequest & { auth: unknown }
  req.auth = { user: { id: "user-1", role, tenantId: "tenant-1", totpEnrolmentRequired: false } }
  return proxy(req)
}
const location = (res: Response) => res.headers.get("location") ?? ""

// Fair Score audit (2026-10-16): an INSURANCE_OFFICER could open collections,
// asset finance and the board pack. It now reads insurance, clients and
// compliance basics, nothing of the loan book (view_loan_book).
describe("INSURANCE_OFFICER and the loan book", () => {
  it.each(LOAN_BOOK_PAGES.filter((p) => p !== "dashboard"))("is sent to the no-access page from /%s", async (page) => {
    for (const url of [`/${page}`, `/${page}/sample`]) {
      const res = await visit(url, "INSURANCE_OFFICER")
      expect([url, res.status, new URL(location(res)).pathname]).toEqual([url, 307, "/no-access"])
    }
  })

  it("lands on its clients list instead of the executive dashboard", async () => {
    const res = await visit("/dashboard", "INSURANCE_OFFICER")
    expect(new URL(location(res)).pathname).toBe("/clients")
  })

  it.each(LOAN_BOOK_APIS)("is refused 403 by /api/%s, reads and writes", async (api) => {
    for (const method of ["GET", "POST", "PATCH", "DELETE"]) {
      expect([method, (await visit(`/api/${api}/sample`, "INSURANCE_OFFICER", method)).status]).toEqual([method, 403])
    }
  })

  it.each(["/clients", "/clients/sample", "/insurance", "/insurance/claims", "/compliance", "/compliance/ncr-return", "/settings/security", "/learn", "/no-access"])(
    "still opens %s", async (url) => {
      const res = await visit(url, "INSURANCE_OFFICER")
      expect([url, res.status]).toEqual([url, 200])
    },
  )

  it.each(["/api/clients/sample", "/api/insurance/claims", "/api/compliance/ncr-return", "/api/notifications"])(
    "still reaches %s", async (url) => {
      expect((await visit(url, "INSURANCE_OFFICER")).status).toBe(200)
    },
  )
})

// Security review of #145: match the path as the router does, not as typed.
describe("path normalisation", () => {
  it.each(["/api//loans/sample", "/api/loans//sample/", "/api/%6Coans/sample", "/api/loans/", "/api/./loans", "/api/insurance/../loans/sample", "/api/%E0%A4%A"])(
    "refuses INSURANCE_OFFICER on %s", async (url) => {
      expect((await visit(url, "INSURANCE_OFFICER")).status).toBe(403)
    },
  )

  it.each(["/api/loansx/sample", "/api/Loans/sample", "/api/clients/loans"])("does not treat %s as the loan book", async (url) => {
    expect((await visit(url, "INSURANCE_OFFICER")).status).not.toBe(403)
  })

  it.each(["//loans", "/loans/", "/%6Coans"])("redirects the page %s", async (url) => {
    const res = await visit(url, "INSURANCE_OFFICER")
    expect(new URL(location(res)).pathname).toBe("/no-access")
  })
})

// The guards' second layer reads the path the proxy stamps; a client value
// for that header must never reach them.
describe("the stamped request path", () => {
  it("replaces a client-supplied value with the real path", async () => {
    const req = new NextRequest("http://localhost/api/insurance/claims", {
      headers: { host: "localhost", "x-cf-request-path": "/api/loans/forged" },
    }) as NextRequest & { auth: unknown }
    req.auth = { user: { id: "user-1", role: "INSURANCE_OFFICER", tenantId: "tenant-1", totpEnrolmentRequired: false } }
    const res = await proxy(req)
    expect(res.headers.get("x-middleware-request-x-cf-request-path")).toBe("/api/insurance/claims")
  })
})

describe("every other staff role keeps the loan book", () => {
  it.each(["READONLY", "COLLECTIONS_OFFICER", "COLLECTIONS_AGENT", "CREDIT_OFFICER", "LOAN_ADMIN", "BRANCH_MANAGER", "ADMIN", "SUPER_ADMIN"])(
    "%s passes the proxy on every loan-book page and API", async (role) => {
      for (const page of LOAN_BOOK_PAGES) expect([page, (await visit(`/${page}`, role)).status]).toEqual([page, 200])
      for (const api of LOAN_BOOK_APIS) expect([api, (await visit(`/api/${api}/sample`, role)).status]).toEqual([api, 200])
    },
  )
})

// Every top-level staff page and API is classified: in the loan book, or open
// to INSURANCE_OFFICER on purpose. A new one fails here until it is decided.
const OPEN_PAGES = ["clients", "compliance", "inbox", "insurance", "learn", "no-access", "settings"]
const OPEN_APIS = [
  "admin", "agent-hub", "audit", "auth", "automation", "branches", "clients", "complaints", "compliance", "cron",
  "documents", "dsar", "email", "health", "inbox", "insurance", "insurers", "integrations", "messaging",
  "notifications", "operator", "pasq-link", "portal", "products", "screening", "selfie-link", "settings",
  "signing-otp", "staff", "users", "v1", "webhooks", "website",
]
const dirs = (dir: string) =>
  readdirSync(path.join(__dirname, dir), { withFileTypes: true })
    .filter((e) => e.isDirectory() && !e.name.startsWith("[")).map((e) => e.name).sort()

// Listed ahead of the PR that adds it (#141), so the gate covers it on arrival.
const FORWARD_DECLARED = ["payment-notifications"]

describe("the loan-book classification", () => {
  it("covers every top-level staff page", () => {
    expect(dirs("app/(dashboard)")).toEqual([...LOAN_BOOK_PAGES, ...OPEN_PAGES].sort())
  })

  it("covers every top-level API", () => {
    const declared = [...LOAN_BOOK_APIS, ...OPEN_APIS].filter((d) => !FORWARD_DECLARED.includes(d) || dirs("app/api").includes(d))
    expect(dirs("app/api")).toEqual(declared.sort())
  })
})

// The second layer: every loan-book route goes through a guard that re-checks
// view_loan_book (lib/auth-guards.ts), directly or through an asset-finance
// route helper that does; every loan-book page segment through
// requireLoanBookPage.
const routeFiles = (dir: string): string[] =>
  readdirSync(path.join(__dirname, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? routeFiles(path.join(dir, e.name)) : e.name === "route.ts" ? [path.join(dir, e.name)] : [])
const GUARDS = /requireApiRole\(|requireOwnerOrStaff\(|from "@\/lib\/asset-finance\/(recovery-route|recovery-sale-route|lease-route|payout-route|signing-route)"/
// Session-checked by hand, and closed to INSURANCE_OFFICER by their own rule.
const OWN_CHECK: Record<string, string> = {
  "app/api/applications/[id]/agreement/sign/route.ts": "CLIENT or CREDIT_OFFICER and above",
  "app/api/applications/[id]/debit-mandate/sign/route.ts": "CLIENT only",
}

describe("the second layer covers every loan-book route", () => {
  const files = LOAN_BOOK_APIS.flatMap((api) => existsSync(path.join(__dirname, "app/api", api)) ? routeFiles(`app/api/${api}`) : [])

  it("has routes to check", () => {
    expect(files.length).toBeGreaterThan(150)
  })

  it.each(files)("%s goes through a re-checking guard", (file) => {
    const source = readFileSync(path.join(__dirname, file), "utf8")
    expect(GUARDS.test(source) || file in OWN_CHECK).toBe(true)
  })

  it.each(["recovery-route", "recovery-sale-route", "lease-route", "payout-route", "signing-route"])("lib/asset-finance/%s.ts calls requireApiRole", (helper) => {
    expect(readFileSync(path.join(__dirname, "lib/asset-finance", `${helper}.ts`), "utf8")).toMatch(/requireApiRole\(/)
  })

  it.each(LOAN_BOOK_PAGES)("the %s page segment calls requireLoanBookPage", (page) => {
    const layout = path.join(__dirname, "app/(dashboard)", page, "layout.tsx")
    const source = existsSync(layout) ? readFileSync(layout, "utf8") : readFileSync(path.join(__dirname, "app/(dashboard)/page.tsx"), "utf8")
    expect(source).toMatch(/requireLoanBookPage\(/)
  })
})

// The reverse check: the insurance module, which INSURANCE_OFFICER keeps, calls
// no API the scope blocks (it would break for that role). Every API path
// literal in its pages and components is read from source.
describe("the insurance module calls nothing in the loan book", () => {
  const sourceFiles = (dir: string): string[] =>
    readdirSync(path.join(__dirname, dir), { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? sourceFiles(path.join(dir, e.name))
        : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [])
  const targets = [...new Set(["app/(dashboard)/insurance", "components/insurance"].flatMap(sourceFiles).flatMap((file) =>
    [...readFileSync(path.join(__dirname, file), "utf8").matchAll(/["'`](\/api\/[A-Za-z0-9_\-/.${}]*)/g)].map((m) => m[1].replace(/\$\{[^}]*\}/g, "sample"))))]

  it("finds the module's API calls", () => {
    expect(targets.length).toBeGreaterThan(5)
  })

  it("none of them is under a blocked prefix", () => {
    expect(targets.filter(isLoanBookPath)).toEqual([])
  })
})

