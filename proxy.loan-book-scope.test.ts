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

  // #145 breaker review: the NCR return is the credit book in figures; the
  // FSCA return (the insurance book) stays open.
  it("is refused the NCR return, page and API, and keeps the FSCA return", async () => {
    for (const url of ["/compliance/ncr-return", "/compliance//ncr-return/"]) {
      expect(new URL(location(await visit(url, "INSURANCE_OFFICER"))).pathname).toBe("/no-access")
    }
    expect((await visit("/api/compliance/ncr-return", "INSURANCE_OFFICER")).status).toBe(403)
    expect((await visit("/api/compliance/ncr-return", "CREDIT_OFFICER")).status).toBe(200)
    expect((await visit("/compliance/fsca-return", "INSURANCE_OFFICER")).status).toBe(200)
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

  it.each(["/clients", "/clients/sample", "/insurance", "/insurance/claims", "/compliance", "/compliance/fsca-return", "/settings/security", "/learn", "/no-access"])(
    "still opens %s", async (url) => {
      const res = await visit(url, "INSURANCE_OFFICER")
      expect([url, res.status]).toEqual([url, 200])
    },
  )

  it.each(["/api/clients/sample", "/api/insurance/claims", "/api/compliance/fsca-return", "/api/notifications"])(
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
// "operator" and "dealer" are their own hosts' APIs: no staff session reaches
// them (lib/proxy/operator-host.ts, lib/proxy/dealer-host.ts).
const OPEN_PAGES = ["clients", "compliance", "inbox", "insurance", "learn", "no-access", "settings"]
const OPEN_APIS = [
  "admin", "agent-hub", "audit", "auth", "automation", "branches", "clients", "complaints", "compliance", "cron",
  "dealer", "documents", "dsar", "email", "health", "inbox", "insurance", "insurers", "integrations", "messaging",
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
const GUARDS = /requireApiRole\(|requireOwnerOrStaff\(|\b(withRecoveryStaff|recoveryWrite|leaseStaffAction|withPayoutStaff|withSigningStaff|withDealerStaff)\(/
// Session-checked by hand, and closed to INSURANCE_OFFICER by their own rule.
const OWN_CHECK: Record<string, string> = {
  "app/api/applications/[id]/agreement/sign/route.ts POST": "CLIENT or CREDIT_OFFICER and above",
  "app/api/applications/[id]/debit-mandate/sign/route.ts POST": "CLIENT only",
  "app/api/applications/[id]/debit-mandate/route.ts POST": "CLIENT only",
}

describe("the second layer covers every loan-book route", () => {
  const files = LOAN_BOOK_APIS.flatMap((api) => existsSync(path.join(__dirname, "app/api", api)) ? routeFiles(`app/api/${api}`) : [])

  it("has routes to check", () => {
    expect(files.length).toBeGreaterThan(150)
  })

  // Per handler, not per file: each exported GET/POST/PUT/PATCH/DELETE, read
  // up to the next export, must itself reach a re-checking guard (directly or
  // through a function of the same file that does).
  const handlers = files.flatMap((file) => {
    const source = readFileSync(path.join(__dirname, file), "utf8")
    const starts = [...source.matchAll(/^export (?:async function|const) (GET|POST|PUT|PATCH|DELETE)\b/gm)]
    return starts.map((m, i) => [`${file} ${m[1]}`, source, source.slice(m.index, starts[i + 1]?.index ?? source.length)] as const)
  }).filter(([name]) => !(name in OWN_CHECK))

  it.each(Object.keys(OWN_CHECK))("%s (own check) refuses every staff role below its floor", (name) => {
    const [file, handler] = name.split(" ")
    const source = readFileSync(path.join(__dirname, file), "utf8")
    const body = source.slice(source.indexOf(`export async function ${handler}`))
    expect(body).toMatch(/role !== "CLIENT"|=== "CLIENT"[\s\S]{0,400}hasMinRole\([^)]*"CREDIT_OFFICER"\)/)
  })
  const localGuarded = (source: string) =>
    new Set([...source.matchAll(/^(?:async )?function (\w+)\([\s\S]*?^\}/gm)].filter((m) => GUARDS.test(m[0])).map((m) => m[1]))

  it("finds every handler", () => {
    expect(handlers.length).toBeGreaterThan(files.length)
  })

  it.each(handlers.map(([name, source, body]) => [name, source, body]))("%s reaches a re-checking guard", (_name, source, body) => {
    const viaLocal = [...localGuarded(source)].some((fn) => new RegExp(`\\b${fn}\\(`).test(body))
    expect(GUARDS.test(body) || viaLocal).toBe(true)
  })

  it.each(["recovery-route", "recovery-sale-route", "lease-route", "payout-route", "signing-route"])("lib/asset-finance/%s.ts calls requireApiRole", (helper) => {
    expect(readFileSync(path.join(__dirname, "lib/asset-finance", `${helper}.ts`), "utf8")).toMatch(/requireApiRole\(/)
  })

  it.each([
    ["withRecoveryStaff", "recovery-route"], ["recoveryWrite", "recovery-sale-route"], ["leaseStaffAction", "lease-route"],
    ["withPayoutStaff", "payout-route"], ["withSigningStaff", "signing-route"],
  ])("%s (lib/asset-finance/%s.ts) is the helper the routes import", (fn, helper) => {
    expect(readFileSync(path.join(__dirname, "lib/asset-finance", `${helper}.ts`), "utf8")).toMatch(new RegExp(`export (async )?function ${fn}\\b`))
  })

  it("withDealerStaff (lib/dealer/staff-route.ts) is exported and calls requireApiRole", () => {
    const source = readFileSync(path.join(__dirname, "lib/dealer/staff-route.ts"), "utf8")
    expect(source).toMatch(/export async function withDealerStaff\b/)
    expect(source).toMatch(/requireApiRole\(/)
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


// Server actions are posted to whatever page rendered them, so a path cannot
// decide them: every "use server" file is classified, and one on loan data
// checks view_loan_book itself (requireLoanBookStaff or canDo(…, "view_loan_book")).
describe("server actions", () => {
  const LOAN_BOOK_ACTIONS = ["app/actions/crm.ts", "app/actions/lead-activities.ts", "app/(dashboard)/payments/bank-reconciliation/actions.ts"]
  const OPEN_ACTIONS = ["app/actions/locale.ts", "app/(dashboard)/learn/actions.ts"]
  const sources = (dir: string): string[] =>
    readdirSync(path.join(__dirname, dir), { withFileTypes: true }).flatMap((e) =>
      e.name === "node_modules" ? [] : e.isDirectory() ? sources(path.join(dir, e.name))
        : /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [path.join(dir, e.name)] : [])
  const actionFiles = ["app", "lib", "components"].flatMap(sources)
    .filter((file) => /^\s*["']use server["']/.test(readFileSync(path.join(__dirname, file), "utf8")))
    .sort()

  it("are all classified", () => {
    expect(actionFiles).toEqual([...LOAN_BOOK_ACTIONS, ...OPEN_ACTIONS].sort())
  })

  it.each(LOAN_BOOK_ACTIONS)("%s checks view_loan_book in every exported action", (file) => {
    const source = readFileSync(path.join(__dirname, file), "utf8")
    const exported = [...source.matchAll(/^export async function (\w+)/gm)].map((m) => m[1])
    expect(exported.length).toBeGreaterThan(0)
    const gate = /requireLoanBookStaff\(|canDo\([^)]*"view_loan_book"\)/
    const guardedHelpers = new Set([...source.matchAll(/^(?:async )?function (\w+)\([\s\S]*?^\}/gm)].filter((m) => gate.test(m[0])).map((m) => m[1]))
    const bodyOf = (name: string) => {
      const start = source.indexOf(`export async function ${name}`)
      const next = source.indexOf("\nexport ", start + 1)
      return source.slice(start, next === -1 ? undefined : next)
    }
    const direct = (name: string) => gate.test(bodyOf(name)) || [...guardedHelpers].some((h) => bodyOf(name).includes(`${h}(`))
    // An action that only delegates to another gated action is gated too.
    const gated = new Set(exported.filter(direct))
    for (const name of exported) {
      expect([name, gated.has(name) || [...gated].some((g) => bodyOf(name).includes(`${g}(`))]).toEqual([name, true])
    }
  })
})
